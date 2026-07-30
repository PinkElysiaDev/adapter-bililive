import type { Context } from 'koishi'
import { Universal } from 'koishi'
import type { BiliLiveConfig } from '../config'
import type { BiliLiveBot } from '../bot'
import type { BiliApiResponse, DanmuInfoData, LiveConnection } from '../types'
import { WSOperation } from '../types'
import { decodePackets, encodePacket } from '../utils'
import { getWebHeaders, WebAuth } from './auth'
import { dispatchWebEvent } from './events'

export class WebWSClient implements LiveConnection {
  private socket: globalThis.WebSocket | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private generation = 0
  private stopped = true
  private readonly logger

  constructor(
    private ctx: Context,
    private config: Extract<BiliLiveConfig, { mode: 'web' }>,
    private bot: BiliLiveBot,
    private auth: WebAuth,
  ) {
    this.logger = ctx.logger('bililive/web')
  }

  async connect(): Promise<void> {
    this.stopped = false
    this.logger.info('正在连接 Web 弹幕服务器：room=%s uid=%s', this.bot.roomId, this.config.uid)
    const info = await this.getDanmuInfo()
    this.bot.debug('getDanmuInfo 成功：hosts=%s tokenLength=%s', info.host_list.length, info.token.length)
    const errors: unknown[] = []
    for (const host of info.host_list) {
      try {
        this.bot.debug('尝试 Web WSS：host=%s port=%s', host.host, host.wss_port)
        await this.connectSocket(`wss://${host.host}:${host.wss_port}/sub`, info.token)
        this.reconnectAttempts = 0
        return
      } catch (error) {
        errors.push(error)
        this.logger.warn('连接 Web 弹幕服务器 %s 失败：%s', host.host, String(error))
      }
    }
    throw new AggregateError(errors, '所有 Web 弹幕服务器均连接失败')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation++
    this.stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < globalThis.WebSocket.CLOSING) socket.close()
  }

  private async getDanmuInfo(): Promise<DanmuInfoData> {
    const params = await this.auth.signWbi({ id: this.bot.roomId, type: 0 })
    const response = await this.ctx.http.get<BiliApiResponse<DanmuInfoData>>(
      'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
      { params, headers: getWebHeaders(this.config.credential, this.bot.roomId) },
    )
    if (response.code !== 0 || !response.data?.token || !response.data.host_list?.length) {
      throw new Error(`获取 Web 弹幕服务器失败：${response.message || response.code}`)
    }
    return response.data
  }

  private connectSocket(url: string, token: string): Promise<void> {
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
        this.bot.debug('Web WSS 已建立，发送认证包：generation=%s', generation)
        const body = Buffer.from(JSON.stringify({
          uid: Number(this.config.credential.dedeUserId || 0),
          roomid: this.bot.roomId,
          protover: 3,
          key: token,
          platform: 'web',
          type: 2,
          buvid: this.config.credential.buvid3,
        }), 'utf8')
        socket.send(encodePacket(WSOperation.AUTH, body))
      })
      socket.addEventListener('message', (event: MessageEvent) => {
        if (this.stopped || generation !== this.generation) return
        try {
          for (const packet of decodePackets(Buffer.from(event.data as ArrayBuffer))) {
            if (packet.operation === WSOperation.AUTH_REPLY) {
              const code = this.readReplyCode(packet.body)
              this.bot.debug('收到 Web WSS 认证回复：code=%s', code)
              if (code !== 0) return fail(new Error(`Web 弹幕认证失败：code=${code}`))
              authenticated = true
              if (!settled) {
                settled = true
                this.startHeartbeat()
                this.bot.online()
                this.logger.info('Web 模式已连接直播间 %s', this.bot.roomId)
                resolve()
              }
            } else if (packet.operation === WSOperation.MESSAGE) {
              const message = JSON.parse(packet.body.toString('utf8'))
              if (message?.cmd) {
                this.bot.debug('收到 Web 弹幕事件：cmd=%s', message.cmd)
                this.bot.debugPayload(`Web 原始事件 ${message.cmd}`, message)
                dispatchWebEvent(this.bot, String(message.cmd), message)
              }
            } else if (packet.operation === WSOperation.HEARTBEAT_REPLY && packet.body.length >= 4) {
              this.bot.dispatchCustom('bililive/online', { count: packet.body.readUInt32BE(0) })
            }
          }
        } catch (error) {
          this.logger.warn('解析 Web 弹幕消息失败：%s', String(error))
        }
      })
      socket.addEventListener('error', () => fail(new Error(`WebSocket 连接失败：${url}`)))
      socket.addEventListener('close', () => {
        this.bot.debug('Web WSS 关闭：authenticated=%s generation=%s currentGeneration=%s stopped=%s', authenticated, generation, this.generation, this.stopped)
        if (this.socket === socket) this.socket = null
        this.stopHeartbeat()
        if (!authenticated) {
          fail(new Error(`WebSocket 在认证前关闭：${url}`))
          return
        }
        if (!this.stopped && generation === this.generation) this.scheduleReconnect()
      })
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.bot.debug('启动 Web WSS 心跳：interval=%sms', this.config.heartbeatInterval)
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === globalThis.WebSocket.OPEN) {
        this.socket.send(encodePacket(WSOperation.HEARTBEAT))
        this.bot.debug('已发送 Web WSS 心跳')
      }
    }, this.config.heartbeatInterval)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.bot.offline(new Error('Web 弹幕连接达到最大重试次数'))
      return
    }
    const attempt = ++this.reconnectAttempts
    const delay = this.config.reconnectInterval * Math.pow(2, attempt - 1)
    this.bot.status = Universal.Status.CONNECT
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(error => {
        this.logger.warn('Web 弹幕重连失败：%s', String(error))
        this.scheduleReconnect()
      })
    }, delay)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private readReplyCode(body: Buffer): number {
    try {
      return Number(JSON.parse(body.toString('utf8'))?.code ?? 0)
    } catch {
      return 0
    }
  }
}
