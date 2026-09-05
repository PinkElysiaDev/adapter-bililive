import { Context, Session } from 'koishi'
import { BiliLiveBot } from './bot'
import type { BiliLiveConfig } from './config'

export { Config } from './config'
export type {
  BiliLiveConfig,
  CommonConfig,
  HybridModeConfig,
  OpenModeConfig,
  OpenPlatformCredential,
  WebCredential,
  WebModeConfig,
} from './config'
export { BiliLiveAdapter } from './adapter'
export { BiliLiveBot } from './bot'

export const name = 'adapter-bililive'
export const inject = { required: ['http'] }

declare module 'koishi' {
  interface Events {
    'bililive/danmaku'(session: Session): void
    'bililive/gift'(session: Session): void
    'bililive/superchat'(session: Session): void
    'bililive/guard'(session: Session): void
    'bililive/like'(session: Session): void
    'bililive/enter'(session: Session): void
    'bililive/follow'(session: Session): void
    'bililive/warning'(session: Session): void
    'bililive/live-start'(session: Session): void
    'bililive/live-end'(session: Session): void
    'bililive/cut-off'(session: Session): void
    'bililive/watched-change'(session: Session): void
    'bililive/online'(session: Session): void
    'bililive/code-expired'(session: Session): void
  }
}

export function apply(ctx: Context, config: BiliLiveConfig): void {
  ctx.plugin(BiliLiveBot, config)
}
