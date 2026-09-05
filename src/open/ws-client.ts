import { Context, Universal } from 'koishi'
import type { OpenConnectionConfig } from '../config'
import type { BiliLiveBot } from '../bot'
import type { WSPacket } from '../types'
import { WSOperation } from '../types'
import { encodePacket, sleep } from '../utils'
import { LiveWSClientBase } from '../ws-client-base'
import { dispatchOpenEvent } from './events'
import { OpenApiError, OpenHttpApi } from './http-api'

/** 会话级 HTTP 心跳间隔（协议要求 20s，缺失超 60s 服务端断开 WS） */
const HTTP_HEARTBEAT_INTERVAL = 20000
/** 单次重连退避上限 */
const MAX_RECONNECT_DELAY = 300000

/** 开放平台长连接客户端：/v2/app/start 会话 + WSS 双心跳 + 会话级重建 */
export class OpenWSClient extends LiveWSClientBase {
  private wsHeartbeatTimer: NodeJS.Timeout | null = null
  private httpHeartbeatTimer: NodeJS.Timeout | null = null
  private isRestarting = false
  private authBody = ''
  private gameId = ''
  private wssLinks: string[] = []
  private linkIndex = 0

  constructor(
    ctx: Context,
    private config: OpenConnectionConfig,
    bot: BiliLiveBot,
    private api: OpenHttpApi,
  ) {
    super(ctx, bot, 'bililive/open')
  }

  async connect(): Promise<void> {
    this.isStopped = false
    this.logger.info('正在创建开放平台会话：appId=%s configuredRoom=%s configuredUid=%s', this.config.appId, this.config.roomId, this.config.uid)
    await this.startSession()
  }

  protected override async cleanup(): Promise<void> {
    if (!this.gameId) return
    try {
      await this.api.appEnd(this.gameId)
    } catch (error) {
      this.logger.warn('结束开放平台会话失败：%s', String(error))
    }
    this.gameId = ''
  }

  protected handlePacket(packet: WSPacket): void {
    if (packet.operation !== WSOperation.MESSAGE) return
    const message = JSON.parse(packet.body.toString('utf8'))
    this.bot.debug('收到开放平台事件：cmd=%s', message.cmd)
    this.bot.debugPayload(`开放平台原始事件 ${message.cmd}`, message.data)
    if (message.cmd === 'LIVE_OPEN_PLATFORM_INTERACTION_END') {
      void this.restartSession('开放平台会话已结束')
    } else {
      dispatchOpenEvent(this.bot, message.cmd, message.data)
    }
  }

  protected startHeartbeats(): void {
    this.stopHeartbeats()
    this.bot.debug('启动开放平台双心跳：ws=%sms http=%sms', this.config.heartbeatInterval, HTTP_HEARTBEAT_INTERVAL)
    this.wsHeartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === globalThis.WebSocket.OPEN) {
        this.socket.send(encodePacket(WSOperation.HEARTBEAT, Buffer.from(this.authBody, 'utf8')))
        this.bot.debug('已发送开放平台 WS 心跳')
      }
    }, this.config.heartbeatInterval)
    this.httpHeartbeatTimer = setInterval(() => {
      if (!this.gameId) return
      this.api.appHeartbeat(this.gameId).then(() => {
        this.bot.debug('开放平台 HTTP 心跳成功')
      }).catch(error => {
        this.logger.warn('开放平台 HTTP 心跳失败：%s', String(error))
        void this.restartSession('HTTP 心跳失败')
      })
    }, HTTP_HEARTBEAT_INTERVAL)
  }

  protected stopHeartbeats(): void {
    if (this.wsHeartbeatTimer) clearInterval(this.wsHeartbeatTimer)
    if (this.httpHeartbeatTimer) clearInterval(this.httpHeartbeatTimer)
    this.wsHeartbeatTimer = null
    this.httpHeartbeatTimer = null
  }

  protected override onConnectionLost(): void {
    void this.scheduleReconnect()
  }

  /** 创建互动会话并建立 WSS 连接；身份码过期（7003）时派发 code-expired 并停止 */
  private async startSession(): Promise<void> {
    try {
      const data = await this.api.appStart()
      this.bot.debug(
        'app/start 成功：room=%s uid=%s gameId=%s wssLinks=%s',
        data.anchor_info.room_id,
        data.anchor_info.uid,
        data.game_info.game_id,
        data.websocket_info.wss_link.length,
      )
      if (Number(data.anchor_info.uid) !== Number(this.config.uid)) {
        throw new Error(`身份码对应主播 ${data.anchor_info.uid}，与配置 UID ${this.config.uid} 不一致`)
      }
      this.authBody = data.websocket_info.auth_body
      this.gameId = data.game_info.game_id
      this.wssLinks = data.websocket_info.wss_link
      this.linkIndex = 0
      if (!this.authBody || !this.gameId || !this.wssLinks.length) throw new Error('开放平台返回的连接信息不完整')
      this.bot.setAnchorInfo(data.anchor_info.room_id, data.anchor_info.uname, data.anchor_info.uface, data.anchor_info.open_id)
      await this.connectAvailableLink()
    } catch (error) {
      if (error instanceof OpenApiError && error.code === 7003) {
        this.bot.dispatchCustom('bililive/code-expired', { code: error.code, message: error.message })
        this.isStopped = true
      }
      if (this.gameId) {
        await this.api.appEnd(this.gameId).catch(() => undefined)
        this.gameId = ''
      }
      throw error
    }
  }

  /** 依次尝试所有 WSS 地址，全部失败时抛出聚合错误 */
  private async connectAvailableLink(): Promise<void> {
    const errors: unknown[] = []
    for (let offset = 0; offset < this.wssLinks.length; offset++) {
      const index = (this.linkIndex + offset) % this.wssLinks.length
      try {
        this.bot.debug('尝试开放平台 WSS：index=%s url=%s', index, this.wssLinks[index])
        await this.connectSocket(this.wssLinks[index], encodePacket(WSOperation.AUTH, Buffer.from(this.authBody, 'utf8')))
        this.linkIndex = index
        this.reconnectAttempts = 0
        return
      } catch (error) {
        errors.push(error)
        this.logger.warn('连接开放平台 WSS 失败：%s', String(error))
      }
    }
    throw new AggregateError(errors, '开放平台所有 WSS 地址均连接失败')
  }

  /** 同会话指数退避重连；次数用尽后升级为重建整个会话 */
  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectTimer || this.isRestarting || this.isStopped) return
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      // 旧 auth_body 可能已被服务端回收，重连无意义，直接重建会话
      this.reconnectAttempts = 0
      void this.restartSession(`达到最大重连次数 ${this.config.maxReconnectAttempts}，重建开放平台会话`)
      return
    }
    const attempt = ++this.reconnectAttempts
    const delay = Math.min(this.config.reconnectInterval * Math.pow(2, attempt - 1), MAX_RECONNECT_DELAY)
    this.bot.status = Universal.Status.RECONNECT
    this.linkIndex = (this.linkIndex + 1) % this.wssLinks.length
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectAvailableLink().catch(error => {
        this.logger.warn('开放平台重连失败：%s', String(error))
        void this.scheduleReconnect()
      })
    }, delay)
  }

  /** 结束当前会话并重新 appStart（会话结束事件、HTTP 心跳失败、重连耗尽时触发） */
  private async restartSession(reason: string): Promise<void> {
    if (this.isRestarting || this.isStopped) return
    this.isRestarting = true
    try {
      this.logger.warn('%s，正在重新创建开放平台会话', reason)
      this.generation++
      this.clearReconnectTimer()
      this.stopHeartbeats()
      this.closeActiveSocket()
      if (this.gameId) await this.api.appEnd(this.gameId).catch(() => undefined)
      this.gameId = ''
      await sleep(this.config.reconnectInterval)
      // 等待期间插件可能已被停用，避免停用后仍创建新会话消耗身份码次数
      if (this.isStopped) return
      await this.startSession()
    } catch (error) {
      this.logger.error('重新创建开放平台会话失败：%s', String(error))
      this.bot.offline(error as Error)
    } finally {
      this.isRestarting = false
    }
  }
}
