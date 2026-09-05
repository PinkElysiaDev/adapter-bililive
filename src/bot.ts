import { Bot, Context, Universal } from 'koishi'
import type { BiliLiveConfig } from './config'
import type { LiveConnection, PendingGift, RoomInfo } from './types'
import { BiliLiveMessageEncoder } from './message'
import { OpenHttpApi } from './open/http-api'
import { OpenWSClient } from './open/ws-client'
import { WebAuth } from './web/auth'
import { WebHttpApi } from './web/http-api'
import { WebWSClient } from './web/ws-client'
import { BiliLiveAdapter } from './adapter'
import { roomScopes } from './utils'

export interface BiliMember {
  name: string
  avatar: string
}

/** 自消息回声内容去重的窗口时长 */
const SENT_DEDUP_WINDOW = 5000
/** 已发送弹幕缓存的清理触发阈值 */
const SENT_CACHE_LIMIT = 50
/** recentMembers 缓存上限：超出后按插入序淘汰最旧条目，防止长时间挂机内存无限增长 */
const MAX_REMEMBERED_MEMBERS = 1000
/** debugPayload 单条日志的最大字符数 */
const DEBUG_PAYLOAD_LIMIT = 4000
/** dispatch 调试日志中消息内容的最大长度 */
const DISPATCH_LOG_LIMIT = 200

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
  /**
   * 主播在开放平台的 open_id：同一 appId + 主播下稳定（换 appId 会变化），每次开播由
   * setAnchorInfo 刷新。仅用于 isSelfMessage 自消息识别，不得写入 user.id——selfId 是
   * user.id 的代理，混入 open_id 会导致 bot.sid 运行时漂移。
   */
  anchorOpenId = ''
  /** 发送弹幕的账号 UID（web/hybrid 模式，用于 Web 自消息判断） */
  readonly senderUid?: string

  /** 最近见过的成员：open_id → {name, avatar}，供 getGuildMember 查询 */
  readonly recentMembers = new Map<string, BiliMember>()
  /** 最近发送的弹幕文本 → 过期时间戳，用于自消息回声兜底过滤 */
  private readonly sentRecent = new Map<string, number>()

  constructor(ctx: Context, config: BiliLiveConfig) {
    super(ctx, config, 'bililive')
    // selfId 是 user.id 的访问器代理：所有模式下恒为配置 uid，运行时不得改写，
    // 否则 bot.sid / ctx.bots 索引 / 统计面板 / 按 selfId 配置的插件都会身份漂移
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
      const sendApi = new WebHttpApi(ctx, config, new WebAuth(ctx, config.credential))
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

  // ---------- 生命周期 ----------

  async connect(): Promise<void> {
    this.logger.info('正在启动 BiliLive Bot：mode=%s，配置房间=%s', this.config.mode, this.config.roomId)
    if (this.config.mode === 'web') {
      await this.setupWebSendApi()
      const user = await this.sendApi!.getUserInfo(this.config.uid)
      this.anchorName = user.name
      this.user = { id: String(this.config.uid), name: user.name, avatar: user.face }
      this.debug('Web 主播信息加载完成：name=%s', user.name)
    } else if (this.config.mode === 'hybrid') {
      await this.setupWebSendApi()
    }
    this.debug('开始建立直播连接')
    await this.connection.connect()
    this.logger.info('BiliLive Bot 已启动，模式=%s，房间=%s', this.config.mode, this.roomId)
  }

  /** web/hybrid 共用的发送侧初始化：校验房间归属、解析真实房号、验证发送账号 */
  private async setupWebSendApi(): Promise<RoomInfo> {
    const api = this.sendApi!
    const room = await api.getRoomInfo()
    this.debug('发送目标校验：realRoom=%s ownerUid=%s title=%s', room.room_id, room.uid, room.title)
    if (Number(room.uid) !== Number(this.config.uid)) {
      throw new Error(`配置房间 ${this.config.roomId} 不属于主播 ${this.config.uid}`)
    }
    this.roomId = room.room_id
    this.roomName = room.title
    api.setRoomId(room.room_id)
    const sender = await api.verifySender()
    this.logger.info('弹幕发送账号已验证：uid=%s name=%s', sender.id, sender.name)
    return room
  }

  async disconnect(): Promise<void> {
    this.debug('停止 Bot，清理连接与 %s 个礼物合并任务', this.pendingGifts.size)
    await this.connection.stop()
    for (const entry of this.pendingGifts.values()) clearTimeout(entry.timer)
    this.pendingGifts.clear()
    this.offline()
  }

  /** 开放平台 app/start 成功后回填主播信息（含真实房号与 open_id 映射） */
  setAnchorInfo(roomId: number, name: string, avatar: string, openId?: string): void {
    this.roomId = roomId
    this.anchorName = name
    if (openId) {
      if (this.anchorOpenId && this.anchorOpenId !== openId) {
        this.logger.warn(
          '主播 open_id 发生变化（%s → %s），可能是 appId 变更；仅影响内部自消息识别，bot 身份不受影响',
          this.anchorOpenId, openId,
        )
      }
      this.anchorOpenId = openId
    }
    // selfId 是 user.id 的代理：恒用配置 uid，open_id 只留在 anchorOpenId 映射里
    this.user = { id: this.anchorUid, name, avatar }
    this.roomName = name ? `${name}的直播间` : `直播间 ${roomId}`
    this.sendApi?.setRoomId(roomId)
    this.debug('开放平台主播信息：realRoom=%s name=%s openId=%s', roomId, name, this.anchorOpenId || '(待识别)')
  }

  // ---------- 事件派发 ----------

  override dispatch(session: Context[typeof Context.session]): void {
    const content = session.content?.replace(/\s+/g, ' ').slice(0, DISPATCH_LOG_LIMIT) || ''
    this.debug(
      'dispatch Session：type=%s channel=%s user=%s content=%j',
      session.type,
      session.channelId || session.event.channel?.id || '',
      session.userId || session.event.user?.id || '',
      content,
    )
    super.dispatch(session)
  }

  /** 派发自定义 bililive/* 事件，原始事件数据合并进 session */
  dispatchCustom(type: string, data: Record<string, any>, timestamp = Date.now()): void {
    this.dispatch(this.session({
      ...data,
      type,
      ...roomScopes(this),
      roomId: this.roomId,
      timestamp,
    } as any))
  }

  // ---------- 弹幕发送 ----------

  /** 发送一条弹幕到直播间；纯 open 模式不支持发送（无 Web API 凭据） */
  async sendDanmaku(content: string): Promise<{ id?: string }> {
    this.debug('收到回复发送请求：mode=%s channel=%s content=%j', this.config.mode, this.channelId, content)
    if (!this.sendApi) {
      const error = new Error('开放平台模式只支持接收事件，无法把指令回复发送到直播间；请切换混合模式或 Web 模式')
      this.logger.warn('%s', error.message)
      throw error
    }
    const result = await this.sendApi.sendDanmaku(content)
    this.debug('直播弹幕发送成功：messageId=%s', result.id || '(B站未返回)')
    return result
  }

  // ---------- 成员缓存 ----------

  /** 记录直播间见过的成员，供 getGuildMember 查询（带上限，近似 FIFO 淘汰） */
  rememberMember(openId: string, name: string, avatar: string): void {
    if (!openId || !name) return
    if (this.recentMembers.has(openId)) return
    if (this.recentMembers.size >= MAX_REMEMBERED_MEMBERS) {
      const oldest = this.recentMembers.keys().next().value
      if (oldest !== undefined) this.recentMembers.delete(oldest)
    }
    this.recentMembers.set(openId, { name, avatar })
  }

  async getGuildMember(guildId: string, userId: string): Promise<Universal.GuildMember> {
    if (guildId !== this.guildId) throw new Error(`未知直播间：${guildId}`)
    const member = this.recentMembers.get(userId)
    if (member) {
      return { user: { id: userId, name: member.name, avatar: member.avatar }, nick: member.name, name: member.name }
    }
    // 未缓存的成员仅知其 id
    return { user: { id: userId }, nick: userId, name: userId }
  }

  // ---------- 自消息过滤（防回声） ----------

  /** 记录本 bot 发送出去的弹幕文本，用于回声兜底过滤 */
  recordSent(content: string): void {
    const trimmed = content.trim()
    if (!trimmed) return
    this.sentRecent.set(trimmed, Date.now() + SENT_DEDUP_WINDOW)
    if (this.sentRecent.size > SENT_CACHE_LIMIT) this.pruneSent()
  }

  /** 判断该文本是否在发送去重窗口内命中（bot 自身回声）；reportSelf 开启时放行 */
  isRecentlySent(content: string): boolean {
    if (this.config.reportSelf) return false
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

  /** 判断是否为 bot 自身消息（Web/Hybrid：uid 命中发送账号；开放平台：open_id 或 uname 命中主播），受 reportSelf 配置控制 */
  isSelfMessage(openId: string, uname: string): boolean {
    if (this.config.reportSelf) return false
    if (openId && this.senderUid && openId === this.senderUid) return true
    if (openId && this.anchorOpenId && openId === this.anchorOpenId) return true
    if (uname && this.anchorName && uname === this.anchorName) return true
    return false
  }

  private pruneSent(): void {
    const now = Date.now()
    for (const [text, expiry] of this.sentRecent) {
      if (now > expiry) this.sentRecent.delete(text)
    }
  }

  // ---------- 频道查询 ----------

  async getChannel(channelId: string): Promise<Universal.Channel> {
    if (channelId !== this.channelId) throw new Error(`未知直播间频道：${channelId}`)
    return { id: channelId, type: Universal.Channel.Type.TEXT, name: this.roomName }
  }

  async getGuild(guildId: string): Promise<Universal.Guild> {
    if (guildId !== this.guildId) throw new Error(`未知直播间：${guildId}`)
    return { id: this.guildId, name: this.roomName, avatar: this.user?.avatar }
  }

  // ---------- 调试 ----------

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
    this.logger.info('[debug] %s：%s', label, serialized.slice(0, DEBUG_PAYLOAD_LIMIT))
  }

  // ---------- 显式声明不支持的能力 ----------

  async sendPrivateMessage(): Promise<string[]> {
    throw new Error('BiliLive 不支持私聊消息')
  }

  async deleteMessage(): Promise<void> {
    throw new Error('B站直播弹幕不支持撤回')
  }
}
