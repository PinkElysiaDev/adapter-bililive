import { Context, Logger } from 'koishi'
import type { BiliLiveBot } from './bot'
import type { LiveConnection, WSPacket } from './types'
import { WSOperation } from './types'
import { decodePackets, readReplyCode } from './utils'

/** WS 认证回复等待上限：服务端建立连接后迟迟不回认证时按失败处理，避免 Promise 永久挂起 */
const AUTH_TIMEOUT = 15000

/**
 * 直播弹幕 WS 客户端公共骨架：认证超时、失败幂等、监听器装配、
 * “迟到的 close 只停当前连接心跳”守卫与停止流程。子类只实现协议差异
 * （心跳形态、消息处理、断线重连策略与停止清理）。
 */
export abstract class LiveWSClientBase implements LiveConnection {
  protected socket: globalThis.WebSocket | null = null
  protected reconnectTimer: NodeJS.Timeout | null = null
  protected reconnectAttempts = 0
  protected generation = 0
  protected isStopped = true
  /** 认证超时（实例字段便于测试注入） */
  protected authTimeout = AUTH_TIMEOUT
  protected readonly logger: Logger

  protected constructor(
    protected ctx: Context,
    protected bot: BiliLiveBot,
    loggerChannel: string,
  ) {
    this.logger = ctx.logger(loggerChannel)
  }

  abstract connect(): Promise<void>

  async stop(): Promise<void> {
    this.isStopped = true
    this.generation++
    this.clearReconnectTimer()
    this.stopHeartbeats()
    this.closeActiveSocket()
    await this.cleanup()
  }

  /** 建立 WS 并等待认证回复；成功后启动心跳并标记 bot 在线 */
  protected connectSocket(url: string, authPacket: Buffer): Promise<void> {
    const generation = ++this.generation
    return new Promise((resolve, reject) => {
      const socket = this.ctx.http.ws(url)
      this.socket = socket
      let authenticated = false
      let settled = false

      // 认证超时兜底：WS 建立但服务端不回认证回复时按失败处理
      const authTimer = setTimeout(() => {
        fail(new Error(`WSS 认证超时：${url}`))
      }, this.authTimeout)

      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(authTimer)
        if (socket.readyState < globalThis.WebSocket.CLOSING) socket.close()
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      socket.addEventListener('open', () => {
        if (this.isStopped || generation !== this.generation) return socket.close()
        this.bot.debug('WSS 已建立，发送认证包：generation=%s', generation)
        socket.send(authPacket)
      })
      socket.addEventListener('message', (event: MessageEvent) => {
        if (this.isStopped || generation !== this.generation) return
        let packets: WSPacket[]
        try {
          packets = decodePackets(Buffer.from(event.data as ArrayBuffer))
        } catch (error) {
          this.logger.warn('解析 WSS 数据包失败：%s', String(error))
          return
        }
        for (const packet of packets) {
          if (packet.operation === WSOperation.AUTH_REPLY) {
            const code = readReplyCode(packet.body)
            this.bot.debug('收到 WSS 认证回复：code=%s', code)
            if (code !== 0) return fail(new Error(`WSS 认证失败：code=${code}`))
            authenticated = true
            if (!settled) {
              settled = true
              clearTimeout(authTimer)
              this.startHeartbeats()
              this.bot.online()
              this.logger.info('已连接直播间 %s', this.bot.roomId)
              resolve()
            }
          } else {
            try {
              this.handlePacket(packet)
            } catch (error) {
              this.logger.warn('处理 WSS 消息失败：%s', String(error))
            }
          }
        }
      })
      socket.addEventListener('error', () => fail(new Error(`WebSocket 连接失败：${url}`)))
      socket.addEventListener('close', () => {
        this.bot.debug('WSS 关闭：authenticated=%s generation=%s currentGeneration=%s stopped=%s', authenticated, generation, this.generation, this.isStopped)
        // 仅当关闭的是当前活跃连接时才停心跳，旧连接迟到的 close 不得误伤新连接
        if (this.socket === socket) {
          this.socket = null
          this.stopHeartbeats()
        }
        if (!authenticated) {
          fail(new Error(`WebSocket 在认证前关闭：${url}`))
          return
        }
        if (!this.isStopped && generation === this.generation) this.onConnectionLost()
      })
    })
  }

  /** 处理认证回复之外的数据包（消息事件、心跳回复等） */
  protected abstract handlePacket(packet: WSPacket): void

  /** 认证成功后启动协议心跳 */
  protected abstract startHeartbeats(): void

  protected abstract stopHeartbeats(): void

  /** 已认证的活跃连接意外关闭（未停用且非过期代次） */
  protected abstract onConnectionLost(): void

  protected closeActiveSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < globalThis.WebSocket.CLOSING) socket.close()
  }

  protected clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  /** stop 时的协议级清理（开放平台需结束互动会话） */
  protected async cleanup(): Promise<void> {}
}
