import { createHash } from 'node:crypto'
import type { Context } from 'koishi'
import type { WebCredential } from '../config'
import type { BiliApiResponse } from '../types'
import { REQUEST_TIMEOUT } from '../types'

/** WBI 签名的混淆字符重排表（B 站公开算法） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]
/** 重排后截取的 mixin key 长度 */
const MIXIN_KEY_LENGTH = 32
/** WBI keys 本地缓存有效期 */
const WBI_KEY_TTL = 10 * 60 * 1000
const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139 Safari/537.36'

export function getCookieHeader(credential: WebCredential): string {
  return [
    `SESSDATA=${credential.sessdata}`,
    `bili_jct=${credential.biliJct}`,
    `DedeUserID=${credential.dedeUserId}`,
    `buvid3=${credential.buvid3}`,
  ].join('; ')
}

export function getWebHeaders(credential: WebCredential, roomId?: number): Record<string, string> {
  return {
    Cookie: getCookieHeader(credential),
    'User-Agent': WEB_USER_AGENT,
    Origin: 'https://live.bilibili.com',
    Referer: roomId ? `https://live.bilibili.com/${roomId}` : 'https://live.bilibili.com/',
  }
}

/** Cookie Web 协议的 WBI 请求签名器，keys 到期自动刷新 */
export class WebAuth {
  private wbiKeys: { imgKey: string; subKey: string } | null = null
  private keysExpireAt = 0
  private refreshPromise: Promise<void> | null = null

  constructor(private ctx: Context, readonly credential: WebCredential) {}

  /** 为请求参数追加 wts 时间戳并计算 w_rid 签名 */
  async signWbi(params: Record<string, string | number>): Promise<Record<string, string | number>> {
    if (!this.wbiKeys || Date.now() >= this.keysExpireAt) await this.refreshKeys()
    const rawKey = this.wbiKeys!.imgKey + this.wbiKeys!.subKey
    const mixinKey = MIXIN_KEY_ENC_TAB.map(index => rawKey[index]).join('').slice(0, MIXIN_KEY_LENGTH)
    const wts = Math.floor(Date.now() / 1000)
    const signed = { ...params, wts }
    const query = Object.keys(signed).sort().map((key) => {
      const value = String(signed[key] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    }).join('&')
    return { ...signed, w_rid: createHash('md5').update(query + mixinKey).digest('hex') }
  }

  private async refreshKeys(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      const response = await this.ctx.http.get<BiliApiResponse<{ wbi_img: { img_url: string; sub_url: string } }>>(
        'https://api.bilibili.com/x/web-interface/nav',
        { headers: getWebHeaders(this.credential), timeout: REQUEST_TIMEOUT },
      )
      if (response.code !== 0 || !response.data?.wbi_img) throw new Error(`获取 WBI Keys 失败：${response.message}`)
      const { img_url: imgUrl, sub_url: subUrl } = response.data.wbi_img
      const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.'))
      const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.'))
      if (!imgKey || !subKey) throw new Error('WBI Keys URL 格式异常')
      this.wbiKeys = { imgKey, subKey }
      this.keysExpireAt = Date.now() + WBI_KEY_TTL
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }
}
