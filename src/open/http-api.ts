import type { Context } from 'koishi'
import type { OpenConnectionConfig } from '../config'
import type { AppStartData, BiliApiResponse } from '../types'
import { OPEN_API_BASE } from '../types'
import { getOpenPlatformHeaders } from './auth'

export class OpenApiError extends Error {
  constructor(public code: number, message: string) {
    super(`开放平台 API 错误 [${code}]：${message}`)
  }
}

export class OpenHttpApi {
  constructor(private ctx: Context, private config: OpenConnectionConfig) {}

  appStart(): Promise<AppStartData> {
    return this.request('/v2/app/start', { code: this.config.code, app_id: this.config.appId })
  }

  appHeartbeat(gameId: string): Promise<unknown> {
    return this.request('/v2/app/heartbeat', { game_id: gameId })
  }

  appEnd(gameId: string): Promise<unknown> {
    return this.request('/v2/app/end', { game_id: gameId, app_id: this.config.appId })
  }

  private async request<T>(path: string, body: object): Promise<T> {
    const headers = getOpenPlatformHeaders(body, this.config.accessKey, this.config.accessSecret)
    const response = await this.ctx.http.post<BiliApiResponse<T>>(OPEN_API_BASE + path, body, { headers })
    if (!response || response.code !== 0) throw new OpenApiError(response?.code, response?.message || '未知错误')
    return response.data
  }
}
