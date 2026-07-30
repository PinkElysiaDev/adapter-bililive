import type { Context } from 'koishi'
import type { WebApiConfig } from '../config'
import type { BiliApiResponse, RoomInfo, UserInfo } from '../types'
import { WebAuth, getWebHeaders } from './auth'

export class WebHttpApi {
  private roomId: number

  constructor(
    private ctx: Context,
    private config: WebApiConfig,
    readonly auth: WebAuth,
  ) {
    this.roomId = config.roomId
  }

  setRoomId(roomId: number): void {
    this.roomId = roomId
  }

  async getRoomInfo(): Promise<RoomInfo> {
    const response = await this.ctx.http.get<BiliApiResponse<RoomInfo>>('https://api.live.bilibili.com/room/v1/Room/get_info', {
      params: { room_id: this.roomId },
      headers: getWebHeaders(this.config.credential, this.roomId),
    })
    this.assertSuccess(response, '获取直播间信息')
    return response.data
  }

  async getUserInfo(uid: number): Promise<UserInfo> {
    const params = await this.auth.signWbi({ mid: uid })
    const response = await this.ctx.http.get<BiliApiResponse<UserInfo>>('https://api.bilibili.com/x/space/wbi/acc/info', {
      params,
      headers: getWebHeaders(this.config.credential, this.roomId),
    })
    this.assertSuccess(response, '获取主播信息')
    return response.data
  }

  async getSenderInfo(): Promise<{ id: string; name: string }> {
    const response = await this.ctx.http.get<BiliApiResponse<{ isLogin: boolean; mid: number | string; uname: string }>>(
      'https://api.bilibili.com/x/web-interface/nav',
      { headers: getWebHeaders(this.config.credential, this.roomId) },
    )
    this.assertSuccess(response, '校验发送账号 Cookie')
    if (!response.data?.isLogin || !response.data.mid) throw new Error('发送账号 Cookie 已失效或未登录')
    const id = String(response.data.mid)
    if (id !== String(this.config.credential.dedeUserId)) {
      throw new Error(`Cookie 登录 UID ${id} 与 DedeUserID ${this.config.credential.dedeUserId} 不一致`)
    }
    return { id, name: response.data.uname || id }
  }

  async sendDanmaku(message: string): Promise<{ id?: string }> {
    if (this.config.debug) this.ctx.logger('bililive/web-http').info('[debug] 请求发送弹幕：room=%s content=%j', this.roomId, message)
    const csrf = this.config.credential.biliJct
    const body = new URLSearchParams({
      msg: message,
      roomid: String(this.roomId),
      color: '16777215',
      fontsize: '25',
      mode: '1',
      rnd: String(Math.floor(Date.now() / 1000)),
      csrf,
      csrf_token: csrf,
    }).toString()
    const response = await this.ctx.http.post<BiliApiResponse<{ msg_id?: string }>>('https://api.live.bilibili.com/msg/send', body, {
      headers: { ...getWebHeaders(this.config.credential, this.roomId), 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    this.assertSuccess(response, '发送弹幕')
    if (this.config.debug) this.ctx.logger('bililive/web-http').info('[debug] B站发送弹幕响应成功：messageId=%s', response.data?.msg_id || '(未返回)')
    return { id: response.data?.msg_id }
  }

  async blockUser(uid: string | number, hour = 1): Promise<void> {
    await this.postForm('https://api.live.bilibili.com/banned_service/v2/Silent/add_block_list', {
      roomid: this.roomId,
      block_uid: uid,
      hour,
    }, '封禁用户')
  }

  async unblockUser(blockId: string | number): Promise<void> {
    await this.postForm('https://api.live.bilibili.com/banned_service/v2/Silent/del_block_list', {
      roomid: this.roomId,
      id: blockId,
    }, '解除封禁')
  }

  private async postForm(url: string, values: Record<string, string | number>, action: string): Promise<void> {
    const csrf = this.config.credential.biliJct
    const body = new URLSearchParams({
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])),
      csrf,
      csrf_token: csrf,
    }).toString()
    const response = await this.ctx.http.post<BiliApiResponse<unknown>>(url, body, {
      headers: { ...getWebHeaders(this.config.credential, this.roomId), 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    this.assertSuccess(response, action)
  }

  private assertSuccess(response: BiliApiResponse<unknown>, action: string): void {
    if (!response || response.code !== 0) throw new Error(`${action}失败：${response?.message || response?.code}`)
  }
}
