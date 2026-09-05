import type { Context } from 'koishi'
import type { WebApiConfig } from '../config'
import type { BiliApiResponse, RoomInfo, UserInfo } from '../types'
import { REQUEST_TIMEOUT } from '../types'
import { WebAuth, getWebHeaders } from './auth'

/** B 站 Web 弹幕默认样式：白色、25 号字、滚动模式 */
const DANMAKU_COLOR = '16777215'
const DANMAKU_FONT_SIZE = '25'
const DANMAKU_MODE = '1'

export class WebHttpApi {
  private roomId: number

  constructor(
    private ctx: Context,
    private config: WebApiConfig,
    readonly auth: WebAuth,
  ) {
    this.roomId = config.roomId
  }

  /** 解析出真实房间号后更新发送目标 */
  setRoomId(roomId: number): void {
    this.roomId = roomId
  }

  /** 获取直播间信息（含真实房号、归属主播、开播状态） */
  async getRoomInfo(): Promise<RoomInfo> {
    const response = await this.ctx.http.get<BiliApiResponse<RoomInfo>>('https://api.live.bilibili.com/room/v1/Room/get_info', {
      params: { room_id: this.roomId },
      headers: this.headers(),
      timeout: REQUEST_TIMEOUT,
    })
    this.assertSuccess(response, '获取直播间信息')
    return response.data
  }

  /** 获取用户公开信息（WBI 签名接口） */
  async getUserInfo(uid: number): Promise<UserInfo> {
    const params = await this.auth.signWbi({ mid: uid })
    const response = await this.ctx.http.get<BiliApiResponse<UserInfo>>('https://api.bilibili.com/x/space/wbi/acc/info', {
      params,
      headers: this.headers(),
      timeout: REQUEST_TIMEOUT,
    })
    this.assertSuccess(response, '获取主播信息')
    return response.data
  }

  /** 校验 Cookie 登录态及 DedeUserID 一致性，返回发送账号信息（失败即抛错） */
  async verifySender(): Promise<{ id: string; name: string }> {
    const response = await this.ctx.http.get<BiliApiResponse<{ isLogin: boolean; mid: number | string; uname: string }>>(
      'https://api.bilibili.com/x/web-interface/nav',
      { headers: this.headers(), timeout: REQUEST_TIMEOUT },
    )
    this.assertSuccess(response, '校验发送账号 Cookie')
    if (!response.data?.isLogin || !response.data.mid) throw new Error('发送账号 Cookie 已失效或未登录')
    const id = String(response.data.mid)
    if (id !== String(this.config.credential.dedeUserId)) {
      throw new Error(`Cookie 登录 UID ${id} 与 DedeUserID ${this.config.credential.dedeUserId} 不一致`)
    }
    return { id, name: response.data.uname || id }
  }

  /** 发送一条直播弹幕；B 站经常不返回 msg_id，此时 id 为空 */
  async sendDanmaku(content: string): Promise<{ id?: string }> {
    const csrf = this.config.credential.biliJct
    const body = new URLSearchParams({
      msg: content,
      roomid: String(this.roomId),
      color: DANMAKU_COLOR,
      fontsize: DANMAKU_FONT_SIZE,
      mode: DANMAKU_MODE,
      rnd: String(Math.floor(Date.now() / 1000)),
      csrf,
      csrf_token: csrf,
    }).toString()
    const response = await this.ctx.http.post<BiliApiResponse<{ msg_id?: string }>>('https://api.live.bilibili.com/msg/send', body, {
      headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: REQUEST_TIMEOUT,
    })
    this.assertSuccess(response, '发送弹幕')
    return { id: response.data?.msg_id }
  }

  private headers(): Record<string, string> {
    return getWebHeaders(this.config.credential, this.roomId)
  }

  private assertSuccess(response: BiliApiResponse<unknown>, action: string): void {
    if (!response || response.code !== 0) throw new Error(`${action}失败：${response?.message || response?.code}`)
  }
}
