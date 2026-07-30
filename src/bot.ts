import { Bot, Context, Universal } from 'koishi'
import type { BiliLiveConfig } from './config'
import type { LiveConnection, PendingGift } from './types'
import { BiliLiveMessageEncoder } from './message'
import { OpenHttpApi } from './open/http-api'
import { OpenWSClient } from './open/ws-client'
import { WebAuth } from './web/auth'
import { WebHttpApi } from './web/http-api'
import { WebWSClient } from './web/ws-client'
import { BiliLiveAdapter } from './adapter'

export interface BiliMember {
  name: string
  avatar: string
}

const SENT_DEDUP_WINDOW = 5000

export class BiliLiveBot extends Bot<Context, BiliLiveConfig> {
  static platform = 'bililive'
  static MessageEncoder = BiliLiveMessageEncoder

  readonly pendingGifts = new Map<string, PendingGift>()
  readonly connection: LiveConnection
  readonly httpApi: OpenHttpApi | WebHttpApi
  readonly sendApi?: WebHttpApi
  roomId: number
  roomName = ''

  /** 主播 B 站 UID（配置项） */
  readonly anchorUid: string
  /** 主播昵称 */
  anchorName = ''
  /** 主播在开放平台的 open_id（用于自消息判断） */
  anchorOpenId = ''
  /** 发送弹幕的账号 UID（web/hybrid 模式，用于 Web 自消息判断） */
  readonly senderUid?: string

  /** 最近见过的成员：open_id → {name, avatar}，供 getGuildMember 查询 */
  readonly recentMembers = new Map<string, BiliMember>()
  /** 最近发送的弹幕文本 → 过期时间戳，用于自消息回声兜底过滤 */
  private readonly sentRecent = new Map<string, number>()

  constructor(ctx: Context, config: BiliLiveConfig) {
    super(ctx, config, 'bililive')
    this.platform = 'bililive'
    this.selfId = String(config.uid)
    this.anchorUid = String(config.uid)
    this.senderUid = config.mode === 'web' || config.mode === 'hybrid'
      ? String(config.credential.dedeUserId)
      : undefined
    this.roomId = config.roomId
    this.user = { id: String(config.uid), name: '' }
    ctx.plugin(BiliLiveAdapter, this)
    this.debug('创建 Bot：mode=%s configuredRoom=%s uid=%s', config.mode, config.roomId, config.uid)

    if (config.mode === 'open') {
      const api = new OpenHttpApi(ctx, config)
      this.httpApi = api
      this.connection = new OpenWSClient(ctx, config, this, api)
    } else if (config.mode === 'hybrid') {
      const openApi = new OpenHttpApi(ctx, config)
      const webAuth = new WebAuth(ctx, config.credential)
      const sendApi = new WebHttpApi(ctx, config, webAuth)
      this.httpApi = openApi
      this.sendApi = sendApi
      this.connection = new OpenWSClient(ctx, config, this, openApi)
    } else {
      const auth = new WebAuth(ctx, config.credential)
      const api = new WebHttpApi(ctx, config, auth)
      this.httpApi = api
      this.sendApi = api
      this.connection = new WebWSClient(ctx, config, this, auth)
    }
  }

  get channelId(): string {
    return `live:${this.roomId}`
  }

  get guildId(): string {
    return this.channelId
  }

  async connect(): Promise<void> {
    this.logger.info('正在启动 BiliLive Bot：mode=%s，配置房间=%s', this.config.mode, this.config.roomId)
    if (this.config.mode === 'web') {
      const api = this.sendApi!
      const room = await api.getRoomInfo()
      this.debug('Web 房间校验结果：realRoom=%s ownerUid=%s title=%s', room.room_id, room.uid, room.title)
      if (Number(room.uid) !== Number(this.config.uid)) {
        throw new Error(`配置房间 ${this.config.roomId} 不属于主播 ${this.config.uid}`)
      }
      this.roomId = room.room_id
      this.roomName = room.title
      api.setRoomId(room.room_id)
      const user = await api.getUserInfo(this.config.uid)
      this.anchorName = user.name
      this.user = { id: String(this.config.uid), name: user.name, avatar: user.face }
      this.debug('Web 主播信息加载完成：name=%s', user.name)
      const sender = await api.getSenderInfo()
      this.logger.info('Web 弹幕发送账号已验证：uid=%s name=%s', sender.id, sender.name)
    } else if (this.config.mode === 'hybrid') {
      const api = this.sendApi!
      const room = await api.getRoomInfo()
      this.debug('混合模式发送目标校验：realRoom=%s ownerUid=%s title=%s', room.room_id, room.uid, room.title)
      if (Number(room.uid) !== Number(this.config.uid)) {
        throw new Error(`配置房间 ${this.config.roomId} 不属于主播 ${this.config.uid}`)
      }
      this.roomId = room.room_id
      this.roomName = room.title
      api.setRoomId(room.room_id)
      const sender = await api.getSenderInfo()
      this.logger.info('混合模式发送器已就绪：room=%s senderUid=%s senderName=%s', room.room_id, sender.id, sender.name)
    }
    this.debug('开始建立直播连接')
    await this.connection.connect()
    this.logger.info('BiliLive Bot 已启动，模式=%s，房间=%s', this.config.mode, this.roomId)
  }

  async disconnect(): Promise<void> {
    this.debug('停止 Bot，清理连接与 %s 个礼物合并任务', this.pendingGifts.size)
    await this.connection.stop()
    for (const entry of this.pendingGifts.values()) clearTimeout(entry.timer)
    this.pendingGifts.clear()
    this.offline()
  }

  setAnchorInfo(roomId: number, name: string, avatar: string, openId?: string): void {
    this.roomId = roomId
    this.anchorName = name
    if (openId) this.anchorOpenId = openId
    // 开放平台下主播以 open_id 作为身份；web 模式仍用 uid
    const selfId = this.anchorOpenId || this.anchorUid
    this.user = { id: selfId, name, avatar }
    this.roomName = name ? `${name}的直播间` : `直播间 ${roomId}`
    this.sendApi?.setRoomId(roomId)
    this.debug('开放平台主播信息：realRoom=%s name=%s openId=%s', roomId, name, this.anchorOpenId || '(待识别)')
  }

  override dispatch(session: Context[typeof Context.session]): void {
    const content = session.content?.replace(/\s+/g, ' ').slice(0, 200) || ''
    this.debug(
      'dispatch Session：type=%s channel=%s user=%s content=%j',
      session.type,
      session.channelId || session.event.channel?.id || '',
      session.userId || session.event.user?.id || '',
      content,
    )
    super.dispatch(session)
  }

  dispatchCustom(type: string, data: Record<string, any>, timestamp = Date.now()): void {
    this.dispatch(this.session({
      ...data,
      type,
      channel: { id: this.channelId, type: Universal.Channel.Type.TEXT, name: this.roomName },
      guild: { id: this.guildId, name: this.roomName },
      roomId: this.roomId,
      timestamp,
    } as any))
  }

  async sendDanmaku(message: string): Promise<{ id?: string }> {
    this.debug('收到回复发送请求：mode=%s channel=%s content=%j', this.config.mode, this.channelId, message)
    if (!this.sendApi) {
      const error = new Error('开放平台模式只支持接收事件，无法把指令回复发送到直播间；请切换混合模式或 Web 模式')
      this.logger.warn('%s', error.message)
      throw error
    }
    try {
      const result = await this.sendApi.sendDanmaku(message)
      this.debug('直播弹幕发送成功：messageId=%s', result.id || '(B站未返回)')
      return result
    } catch (error) {
      this.logger.error('直播弹幕发送失败：%s', String(error))
      throw error
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this.config.debug) this.logger.info(`[debug] ${message}`, ...args)
  }

  debugPayload(label: string, payload: unknown): void {
    if (!this.config.debug) return
    let serialized: string
    try {
      serialized = JSON.stringify(payload)
    } catch {
      serialized = String(payload)
    }
    this.logger.info('[debug] %s：%s', label, serialized.slice(0, 4000))
  }

  async getSelf(): Promise<Universal.User> {
    return this.user!
  }

  async getChannel(channelId: string): Promise<Universal.Channel> {
    if (channelId !== this.channelId) throw new Error(`未知直播间频道：${channelId}`)
    return { id: channelId, type: Universal.Channel.Type.TEXT, name: this.roomName }
  }

  async getGuild(guildId: string): Promise<Universal.Guild> {
    if (guildId !== this.guildId) throw new Error(`未知直播间：${guildId}`)
    return { id: this.guildId, name: this.roomName, avatar: this.user?.avatar }
  }

  async getGuildMember(guildId: string, userId: string): Promise<Universal.GuildMember> {
    if (guildId !== this.guildId) throw new Error(`未知直播间：${guildId}`)
    const member = this.recentMembers.get(userId)
    if (member) {
      return { user: { id: userId, name: member.name, avatar: member.avatar }, nick: member.name, name: member.name }
    }
    return { user: { id: userId }, nick: userId, name: userId }
  }

  /** 记录已见过的成员，供 getGuildMember 查询 */
  rememberMember(openId: string, name: string, avatar: string): void {
    if (!openId || !name) return
    if (!this.recentMembers.has(openId)) {
      this.recentMembers.set(openId, { name, avatar })
    }
  }

  /** 记录本 bot 发送出去的弹幕文本，用于自消息回声兜底过滤 */
  recordSent(content: string): void {
    const trimmed = content.trim()
    if (!trimmed) return
    this.sentRecent.set(trimmed, Date.now() + SENT_DEDUP_WINDOW)
    if (this.sentRecent.size > 50) this.pruneSent()
  }

  /** 判断该文本是否在发送去重窗口内命中（bot 自身回声） */
  isRecentlySent(content: string): boolean {
    const trimmed = content.trim()
    if (!trimmed) return false
    const expiry = this.sentRecent.get(trimmed)
    if (expiry === undefined) return false
    if (Date.now() > expiry) {
      this.sentRecent.delete(trimmed)
      return false
    }
    return true
  }

  private pruneSent(): void {
    const now = Date.now()
    for (const [text, expiry] of this.sentRecent) {
      if (now > expiry) this.sentRecent.delete(text)
    }
  }

  /** 判断是否为 bot 自身消息（开放平台：open_id 或 uname 命中主播；Web：uid 命中发送账号） */
  isSelfMessage(openId: string, uname: string): boolean {
    if (openId && this.anchorOpenId && openId === this.anchorOpenId) return true
    if (uname && this.anchorName && uname === this.anchorName) return true
    return false
  }

  async sendPrivateMessage(): Promise<string[]> {
    throw new Error('BiliLive 不支持私聊消息')
  }

  async deleteMessage(): Promise<void> {
    throw new Error('B站直播弹幕不支持撤回')
  }
}
