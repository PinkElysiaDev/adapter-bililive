import { Context, Universal } from 'koishi'
import type { BiliLiveConfig } from '../config'
import type { BiliLiveBot } from '../bot'
import type { BiliApiResponse, DanmuInfoData, WSPacket } from '../types'
import { REQUEST_TIMEOUT, WSOperation } from '../types'
import { encodePacket } from '../utils'
import { LiveWSClientBase } from '../ws-client-base'
import { getWebHeaders, WebAuth } from './auth'
import { dispatchWebEvent } from './events'

/** Web 弹幕 WS 的压缩协议版本（3 = brotli） */
const WS_PROTOCOL_VERSION = 3
/** 单次重连退避上限 */
const MAX_RECONNECT_DELAY = 300000
/** 重试次数用尽后的慢速重试间隔：直播挂机场景自愈，直到手动停用 */
const SLOW_RETRY_INTERVAL = 60000

/** 传统 Cookie Web 协议客户端：getDanmuInfo 获取入口后连 WSS，单心跳 */
export class WebWSClient extends LiveWSClientBase {
  private heartbeatTimer: NodeJS.Timeout | null = null
  /** 上次连接成功的 host 下标，重连时从下一个开始轮换 */
  private hostIndex = 0
  /** 重试次数用尽后进入慢速无限重试模式 */
  private isSlowRetry = false
  /** 慢速重试间隔（实例字段便于测试注入） */
  protected slowRetryInterval = SLOW_RETRY_INTERVAL

  constructor(
    ctx: Context,
    private config: Extract<BiliLiveConfig, { mode: 'web' }>,
    bot: BiliLiveBot,
    private auth: WebAuth,
  ) {
    super(ctx, bot, 'bililive/web')
  }

  async connect(): Promise<void> {
    this.isStopped = false
    this.logger.info('正在连接 Web 弹幕服务器：room=%s uid=%s', this.bot.roomId, this.config.uid)
    const info = await this.getDanmuInfo()
    this.bot.debug('getDanmuInfo 成功：hosts=%s tokenLength=%s', info.host_list.length, info.token.length)
    const errors: unknown[] = []
    const hosts = info.host_list
    for (let offset = 0; offset < hosts.length; offset++) {
      const index = (this.hostIndex + offset) % hosts.length
      const host = hosts[index]
      try {
        this.bot.debug('尝试 Web WSS：host=%s port=%s', host.host, host.wss_port)
        await this.connectSocket(`wss://${host.host}:${host.wss_port}/sub`, this.buildAuthPacket(info.token))
        this.hostIndex = (index + 1) % hosts.length
        this.reconnectAttempts = 0
        this.isSlowRetry = false
        return
      } catch (error) {
        errors.push(error)
        this.logger.warn('连接 Web 弹幕服务器 %s 失败：%s', host.host, String(error))
      }
    }
    throw new AggregateError(errors, '所有 Web 弹幕服务器均连接失败')
  }

  protected handlePacket(packet: WSPacket): void {
    if (packet.operation === WSOperation.HEARTBEAT_REPLY && packet.body.length >= 4) {
      this.bot.dispatchCustom('bililive/online', { count: packet.body.readUInt32BE(0) })
      return
    }
    if (packet.operation !== WSOperation.MESSAGE) return
    const message = JSON.parse(packet.body.toString('utf8'))
    if (!message?.cmd) return
    this.bot.debug('收到 Web 弹幕事件：cmd=%s', message.cmd)
    this.bot.debugPayload(`Web 原始事件 ${message.cmd}`, message)
    dispatchWebEvent(this.bot, String(message.cmd), message)
  }

  protected startHeartbeats(): void {
    this.stopHeartbeats()
    this.bot.debug('启动 Web WSS 心跳：interval=%sms', this.config.heartbeatInterval)
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === globalThis.WebSocket.OPEN) {
        this.socket.send(encodePacket(WSOperation.HEARTBEAT))
        this.bot.debug('已发送 Web WSS 心跳')
      }
    }, this.config.heartbeatInterval)
  }

  protected stopHeartbeats(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  protected override onConnectionLost(): void {
    this.scheduleReconnect()
  }

  private buildAuthPacket(token: string): Buffer {
    const body = Buffer.from(JSON.stringify({
      uid: Number(this.config.credential.dedeUserId || 0),
      roomid: this.bot.roomId,
      protover: WS_PROTOCOL_VERSION,
      key: token,
      platform: 'web',
      type: 2,
      buvid: this.config.credential.buvid3,
    }), 'utf8')
    return encodePacket(WSOperation.AUTH, body)
  }

  private async getDanmuInfo(): Promise<DanmuInfoData> {
    const params = await this.auth.signWbi({ id: this.bot.roomId, type: 0 })
    const response = await this.ctx.http.get<BiliApiResponse<DanmuInfoData>>(
      'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
      { params, headers: getWebHeaders(this.config.credential, this.bot.roomId), timeout: REQUEST_TIMEOUT },
    )
    if (response.code !== 0 || !response.data?.token || !response.data.host_list?.length) {
      throw new Error(`获取 Web 弹幕服务器失败：${response.message || response.code}`)
    }
    return response.data
  }

  /** 快速指数退避重试；次数用尽后降级为固定间隔慢速无限重试，直到手动停用 */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isStopped) return
    if (!this.isSlowRetry && this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.isSlowRetry = true
      this.reconnectAttempts = 0
      this.logger.warn('Web 弹幕连接达到最大重试次数 %s，转入每 %sms 慢速重试', this.config.maxReconnectAttempts, this.slowRetryInterval)
    }
    const attempt = ++this.reconnectAttempts
    const delay = this.isSlowRetry
      ? this.slowRetryInterval
      : Math.min(this.config.reconnectInterval * Math.pow(2, attempt - 1), MAX_RECONNECT_DELAY)
    this.bot.status = Universal.Status.CONNECT
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(error => {
        this.logger.warn('Web 弹幕重连失败：%s', String(error))
        this.scheduleReconnect()
      })
    }, delay)
  }
}
