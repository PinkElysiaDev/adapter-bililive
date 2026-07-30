import { Context, Universal } from 'koishi'
import type { OpenConnectionConfig } from '../config'
import type { BiliLiveBot } from '../bot'
import type { LiveConnection } from '../types'
import { WSOperation } from '../types'
import { decodePackets, encodePacket, sleep } from '../utils'
import { dispatchOpenEvent } from './events'
import { OpenApiError, OpenHttpApi } from './http-api'

export class OpenWSClient implements LiveConnection {
  private socket: globalThis.WebSocket | null = null
  private wsHeartbeatTimer: NodeJS.Timeout | null = null
  private httpHeartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private authBody = ''
  private gameId = ''
  private wssLinks: string[] = []
  private linkIndex = 0
  private reconnectAttempts = 0
  private generation = 0
  private stopped = true
  private restarting = false
  private readonly logger

  constructor(
    private ctx: Context,
    private config: OpenConnectionConfig,
    private bot: BiliLiveBot,
    private api: OpenHttpApi,
  ) {
    this.logger = ctx.logger('bililive/open')
  }

  async connect(): Promise<void> {
    this.stopped = false
    this.logger.info('正在创建开放平台会话：appId=%s configuredRoom=%s configuredUid=%s', this.config.appId, this.config.roomId, this.config.uid)
    await this.startSession()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation++
    this.clearReconnectTimer()
    this.stopHeartbeats()
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < globalThis.WebSocket.CLOSING) socket.close()
    if (this.gameId) {
      try {
        await this.api.appEnd(this.gameId)
      } catch (error) {
        this.logger.warn('结束开放平台会话失败：%s', String(error))
      }
    }
    this.gameId = ''
  }

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
        this.stopped = true
      }
      if (this.gameId) {
        await this.api.appEnd(this.gameId).catch(() => undefined)
        this.gameId = ''
      }
      throw error
    }
  }

  private async connectAvailableLink(): Promise<void> {
    const errors: unknown[] = []
    for (let offset = 0; offset < this.wssLinks.length; offset++) {
      const index = (this.linkIndex + offset) % this.wssLinks.length
      try {
        this.bot.debug('尝试开放平台 WSS：index=%s url=%s', index, this.wssLinks[index])
        await this.connectSocket(this.wssLinks[index])
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

  private connectSocket(url: string): Promise<void> {
    const generation = ++this.generation
    return new Promise((resolve, reject) => {
      const socket = this.ctx.http.ws(url)
      this.socket = socket
      let authenticated = false
      let settled = false

      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        if (socket.readyState < globalThis.WebSocket.CLOSING) socket.close()
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      socket.addEventListener('open', () => {
        if (this.stopped || generation !== this.generation) return socket.close()
        this.bot.debug('开放平台 WSS 已建立，发送认证包：generation=%s authBodyLength=%s', generation, this.authBody.length)
        socket.send(encodePacket(WSOperation.AUTH, Buffer.from(this.authBody, 'utf8')))
      })
      socket.addEventListener('message', (event: MessageEvent) => {
        if (this.stopped || generation !== this.generation) return
        try {
          for (const packet of decodePackets(Buffer.from(event.data as ArrayBuffer))) {
            if (packet.operation === WSOperation.AUTH_REPLY) {
              const code = this.readReplyCode(packet.body)
              this.bot.debug('收到开放平台认证回复：code=%s', code)
              if (code !== 0) return fail(new Error(`开放平台 WSS 认证失败：code=${code}`))
              authenticated = true
              if (!settled) {
                settled = true
                this.startHeartbeats()
                this.bot.online()
                this.logger.info('开放平台已连接直播间 %s', this.bot.roomId)
                resolve()
              }
            } else if (packet.operation === WSOperation.MESSAGE) {
              const message = JSON.parse(packet.body.toString('utf8'))
              this.bot.debug('收到开放平台事件：cmd=%s', message.cmd)
              this.bot.debugPayload(`开放平台原始事件 ${message.cmd}`, message.data)
              if (message.cmd === 'LIVE_OPEN_PLATFORM_INTERACTION_END') {
                void this.restartSession('开放平台会话已结束')
              } else {
                dispatchOpenEvent(this.bot, message.cmd, message.data)
              }
            }
          }
        } catch (error) {
          this.logger.warn('解析开放平台消息失败：%s', String(error))
        }
      })
      socket.addEventListener('error', () => fail(new Error(`WebSocket 连接失败：${url}`)))
      socket.addEventListener('close', () => {
        this.bot.debug('开放平台 WSS 关闭：authenticated=%s generation=%s currentGeneration=%s stopped=%s', authenticated, generation, this.generation, this.stopped)
        if (this.socket === socket) this.socket = null
        this.stopHeartbeats()
        if (!authenticated) {
          fail(new Error(`WebSocket 在认证前关闭：${url}`))
          return
        }
        if (!this.stopped && generation === this.generation) void this.scheduleReconnect()
      })
    })
  }

  private startHeartbeats(): void {
    this.stopHeartbeats()
    this.bot.debug('启动开放平台双心跳：ws=%sms http=20000ms', this.config.heartbeatInterval)
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
    }, 20000)
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectTimer || this.restarting || this.stopped) return
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.logger.error('开放平台达到最大重连次数 %s', this.config.maxReconnectAttempts)
      this.bot.offline(new Error('开放平台 WebSocket 重连失败'))
      return
    }
    const attempt = ++this.reconnectAttempts
    const delay = this.config.reconnectInterval * Math.pow(2, attempt - 1)
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

  private async restartSession(reason: string): Promise<void> {
    if (this.restarting || this.stopped) return
    this.restarting = true
    this.logger.warn('%s，正在重新创建开放平台会话', reason)
    this.generation++
    this.clearReconnectTimer()
    this.stopHeartbeats()
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < globalThis.WebSocket.CLOSING) socket.close()
    if (this.gameId) await this.api.appEnd(this.gameId).catch(() => undefined)
    this.gameId = ''
    await sleep(this.config.reconnectInterval)
    try {
      await this.startSession()
    } catch (error) {
      this.logger.error('重新创建开放平台会话失败：%s', String(error))
      this.bot.offline(error as Error)
    } finally {
      this.restarting = false
    }
  }

  private stopHeartbeats(): void {
    if (this.wsHeartbeatTimer) clearInterval(this.wsHeartbeatTimer)
    if (this.httpHeartbeatTimer) clearInterval(this.httpHeartbeatTimer)
    this.wsHeartbeatTimer = null
    this.httpHeartbeatTimer = null
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private readReplyCode(body: Buffer): number {
    try {
      return Number(JSON.parse(body.toString('utf8'))?.code ?? 0)
    } catch {
      return 0
    }
  }
}
