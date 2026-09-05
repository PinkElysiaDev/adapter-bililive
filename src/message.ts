import { Context, h, MessageEncoder, Universal } from 'koishi'
import type { BiliLiveBot } from './bot'
import { sleep } from './utils'

// 按字素（用户感知字符）切分，避免把组合 emoji（ZWJ 序列、肤色修饰符等）拆成乱码
const GraphemeSegmenter = (Intl as any).Segmenter as
  | (new (locale?: string, options?: { granularity?: string }) => { segment(input: string): Iterable<{ segment: string }> })
  | undefined

function splitGraphemes(content: string): string[] {
  if (!GraphemeSegmenter) return Array.from(content)
  return Array.from(new GraphemeSegmenter('zh', { granularity: 'grapheme' }).segment(content), part => part.segment)
}

/** 按字素把长弹幕切成不超过 maxLength 的分片，保证每片都是完整字符 */
function splitDanmakuChunks(content: string, maxLength: number): string[] {
  const chunks: string[] = []
  let current: string[] = []
  for (const grapheme of splitGraphemes(content)) {
    if (current.length >= maxLength) {
      chunks.push(current.join(''))
      current = []
    }
    current.push(grapheme)
  }
  if (current.length) chunks.push(current.join(''))
  return chunks
}

export class BiliLiveMessageEncoder extends MessageEncoder<Context, BiliLiveBot> {
  private buffer = ''

  async flush(): Promise<void> {
    if (this.channelId !== this.bot.channelId) {
      this.bot.logger.warn('目标频道 %s 与直播间频道 %s 不一致，弹幕仍将发送到直播间', this.channelId, this.bot.channelId)
    }
    const content = this.buffer.trim()
    this.buffer = ''
    if (!content) return
    const chunks = splitDanmakuChunks(content, this.bot.config.maxDanmakuLength)
    this.bot.debug('MessageEncoder：原始长度=%s，分片数=%s，单片上限=%s', splitGraphemes(content).length, chunks.length, this.bot.config.maxDanmakuLength)
    for (let index = 0; index < chunks.length; index++) {
      if (index > 0) await sleep(this.bot.config.sendInterval)
      this.bot.debug('MessageEncoder：发送第 %s/%s 片 content=%j', index + 1, chunks.length, chunks[index])
      try {
        const result = await this.bot.sendDanmaku(chunks[index])
        const message: Universal.Message = { id: result.id ?? '', content: chunks[index] }
        this.results.push(message)
        // 记录已发送弹幕文本，供自消息回声兜底过滤
        this.bot.recordSent(chunks[index])
        // 派发 send 事件（analytics 数据统计、status 概况等均依赖此事件统计发送消息）
        const session = this.bot.session({
          type: 'send',
          channel: { id: this.bot.channelId, type: Universal.Channel.Type.TEXT, name: this.bot.roomName },
          guild: { id: this.bot.guildId, name: this.bot.roomName },
          user: { id: this.bot.senderUid ?? this.bot.selfId },
          message: { ...message, elements: [h.text(chunks[index])], timestamp: Date.now() },
        })
        session.app.emit(session, 'send', session)
      } catch (error) {
        this.bot.logger.error('MessageEncoder 发送失败：chunk=%s/%s error=%s', index + 1, chunks.length, String(error))
        throw error
      }
    }
  }

  async visit(element: h): Promise<void> {
    if (element.type === 'text') {
      this.buffer += element.attrs.content ?? ''
    } else if (element.type === 'at') {
      this.buffer += `@${element.attrs.name || element.attrs.id || ''} `
    } else if (element.type === 'br' || element.type === 'p') {
      this.buffer += ' '
    } else if (element.type === 'image' || element.type === 'img') {
      this.bot.logger.warn('B站直播弹幕不支持发送图片，已忽略')
    } else {
      for (const child of element.children || []) await this.visit(child)
    }
  }
}
