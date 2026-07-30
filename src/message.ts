import { Context, h, MessageEncoder } from 'koishi'
import type { BiliLiveBot } from './bot'
import { sleep } from './utils'

export class BiliLiveMessageEncoder extends MessageEncoder<Context, BiliLiveBot> {
  private buffer = ''

  async flush(): Promise<void> {
    const content = this.buffer.trim()
    this.buffer = ''
    if (!content) return
    const maxLength = Math.max(1, this.bot.config.maxDanmakuLength)
    const chunks = Array.from(content).reduce<string[]>((result, character) => {
      const last = result[result.length - 1]
      if (!last || Array.from(last).length >= maxLength) result.push(character)
      else result[result.length - 1] += character
      return result
    }, [])
    this.bot.debug('MessageEncoder：原始长度=%s，分片数=%s，单片上限=%s', Array.from(content).length, chunks.length, maxLength)
    for (let index = 0; index < chunks.length; index++) {
      if (index > 0) await sleep(this.bot.config.sendInterval)
      this.bot.debug('MessageEncoder：发送第 %s/%s 片 content=%j', index + 1, chunks.length, chunks[index])
      try {
        const result = await this.bot.sendDanmaku(chunks[index])
        this.results.push({ id: result.id ?? '' })
        // 记录已发送弹幕文本，供自消息回声兜底过滤
        this.bot.recordSent(chunks[index])
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
