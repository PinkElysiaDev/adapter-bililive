export enum WSOperation {
  HEARTBEAT = 2,
  HEARTBEAT_REPLY = 3,
  MESSAGE = 5,
  AUTH = 7,
  AUTH_REPLY = 8,
}

export interface WSPacket {
  operation: WSOperation
  protocolVersion: number
  body: Buffer
}

export interface BiliApiResponse<T> {
  code: number
  message: string
  data: T
}

export interface AppStartData {
  anchor_info: { room_id: number; uid: number; uname: string; uface: string; open_id?: string }
  game_info: { game_id: string }
  websocket_info: { auth_body: string; wss_link: string[] }
}

export interface DanmuInfoData {
  token: string
  host_list: Array<{ host: string; port: number; wss_port: number; ws_port: number }>
}

export interface RoomInfo {
  room_id: number
  short_id?: number
  uid: number
  title: string
  live_status: number
  online: number
}

export interface UserInfo {
  mid: number
  name: string
  face: string
}

export interface OpenDMData {
  msg: string
  uid: number | string
  uname: string
  uface: string
  guard_level: number
  timestamp: number
  msg_id: string
  room_id: number
  open_id: string
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
}

export interface OpenGiftData {
  uid: number | string
  uname: string
  uface: string
  gift_id: number
  gift_name: string
  gift_num: number
  price: number
  paid: boolean
  guard_level: number
  timestamp: number
  msg_id: string
  room_id: number
  open_id: string
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
  combo_id: string
  combo_num: number
}

export interface OpenSuperChatData {
  uid: number | string
  uname: string
  uface: string
  message: string
  rmb: number
  start_time: number
  end_time: number
  msg_id: string
  room_id: number
  open_id: string
  guard_level: number
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
}

export interface OpenGuardData {
  user_info: { uid: number | string; uname: string; uface: string; open_id?: string }
  guard_level: number
  guard_num: number
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
  room_id: number
  msg_id: string
  timestamp: number
  open_id?: string
}

export interface OpenInteractData {
  uid: number | string
  uname: string
  uface: string
  timestamp: number
  room_id: number
  like_text?: string
  like_count?: number
  open_id?: string
}

export interface WarningData {
  msg: string
  room_id: number
}

export interface PendingGift<T = any> {
  data: T
  totalNum: number
  timer: NodeJS.Timeout | undefined
}

export interface LiveConnection {
  connect(): Promise<void>
  stop(): Promise<void>
}

export const GUARD_NAMES: Record<number, string> = { 1: '总督', 2: '提督', 3: '舰长' }
export const OPEN_API_BASE = 'https://live-open.biliapi.com'
/** B 站 HTTP API 请求超时，防止接口挂起拖住发送/心跳/重连链路 */
export const REQUEST_TIMEOUT = 15000
