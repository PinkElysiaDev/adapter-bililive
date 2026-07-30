import { Adapter, Context } from 'koishi'
import type { BiliLiveBot } from './bot'

export class BiliLiveAdapter extends Adapter<Context, BiliLiveBot> {
  static reusable = true

  async connect(bot: BiliLiveBot): Promise<void> {
    bot.logger.info('adapter connecting: mode=%s room=%s debug=%s', bot.config.mode, bot.config.roomId, bot.config.debug)
    try {
      await bot.connect()
    } catch (error) {
      bot.logger.error('adapter connection failed: %s', String(error))
      throw error
    }
  }

  async disconnect(bot: BiliLiveBot): Promise<void> {
    bot.logger.info('adapter disconnecting')
    await bot.disconnect()
  }
}
