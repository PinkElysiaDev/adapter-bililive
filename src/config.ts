import { Schema } from 'koishi'

export interface OpenPlatformCredential {
  appId: number
  accessKey: string
  accessSecret: string
  code: string
}

export interface WebCredential {
  sessdata: string
  biliJct: string
  dedeUserId: string
  buvid3: string
}

export interface OpenModeConfig extends OpenPlatformCredential {
  mode: 'open'
}

export interface HybridModeConfig extends OpenPlatformCredential {
  mode: 'hybrid'
  credential: WebCredential
}

export interface WebModeConfig {
  mode: 'web'
  credential: WebCredential
}

export interface CommonConfig {
  roomId: number
  uid: number
  sendInterval: number
  maxDanmakuLength: number
  reportSelf: boolean
  giftComboDuration: number
  heartbeatInterval: number
  maxReconnectAttempts: number
  reconnectInterval: number
  debug: boolean
}

export type BiliLiveConfig = (OpenModeConfig | HybridModeConfig | WebModeConfig) & CommonConfig
export type OpenConnectionConfig = Extract<BiliLiveConfig, { mode: 'open' | 'hybrid' }>
export type WebApiConfig = Extract<BiliLiveConfig, { mode: 'web' | 'hybrid' }>

export const Config: Schema<BiliLiveConfig> = Schema.intersect([
  Schema.object({
    mode: Schema.union([
      Schema.const('open').description('开放平台'),
      Schema.const('hybrid').description('混合模式'),
      Schema.const('web').description('Cookie Web'),
    ])
      .role('radio')
      .default('open')
      .description('连接模式：混合模式使用开放平台接收，并通过 Cookie Web API 发送弹幕'),
  }).description('模式设置'),
  Schema.union([
    Schema.object({
      mode: Schema.const('open'),
      appId: Schema.number().min(1).required().description('开放平台“应用管理”中应用详情的 appId；不是直播间号、主播 UID 或身份码'),
      accessKey: Schema.string().required().role('secret').description('access_key_id'),
      accessSecret: Schema.string().required().role('secret').description('access_key_secret'),
      code: Schema.string().required().role('secret').description('主播在开放平台为本次开播获取的身份码；它与 appId 不同，并可能过期'),
    }).description('开放平台认证'),
    Schema.object({
      mode: Schema.const('hybrid').required(),
      appId: Schema.number().min(1).required().description('开放平台“应用管理”中应用详情的 appId'),
      accessKey: Schema.string().required().role('secret').description('access_key_id'),
      accessSecret: Schema.string().required().role('secret').description('access_key_secret'),
      code: Schema.string().required().role('secret').description('主播身份码'),
      credential: Schema.object({
        sessdata: Schema.string().required().role('secret').description('发送账号的 SESSDATA'),
        biliJct: Schema.string().required().role('secret').description('发送账号的 bili_jct'),
        dedeUserId: Schema.string().required().description('发送账号的 DedeUserID'),
        buvid3: Schema.string().required().description('发送账号的 buvid3'),
      }).required().description('仅用于发送弹幕的 Cookie 凭据'),
    }).description('混合模式认证'),
    Schema.object({
      mode: Schema.const('web').required(),
      credential: Schema.object({
        sessdata: Schema.string().required().role('secret').description('SESSDATA'),
        biliJct: Schema.string().required().role('secret').description('bili_jct'),
        dedeUserId: Schema.string().required().description('DedeUserID'),
        buvid3: Schema.string().required().description('buvid3'),
      }).required().description('Cookie 凭据'),
    }).description('Cookie Web 认证'),
  ]).description('认证设置'),
  Schema.object({
    roomId: Schema.number().min(1).required().description('直播间房间号（短号或真实号）'),
    uid: Schema.number().min(1).required().description('主播 UID'),
    sendInterval: Schema.number().min(0).default(1000).role('ms').description('弹幕发送间隔'),
    maxDanmakuLength: Schema.number().min(1).default(20).description('单条弹幕最大长度'),
    reportSelf: Schema.boolean().default(false).description('上报自身消息'),
    giftComboDuration: Schema.number().min(0).default(3000).role('ms').description('礼物连击合并时间'),
    heartbeatInterval: Schema.number().min(1000).default(30000).role('ms').description('WebSocket 心跳间隔'),
    maxReconnectAttempts: Schema.number().min(0).default(5).description('最大重连次数'),
    reconnectInterval: Schema.number().min(0).default(3000).role('ms').description('重连间隔基数'),
    debug: Schema.boolean().default(false).description('输出完整消息链路调试日志'),
  }),
]) as Schema<BiliLiveConfig>
