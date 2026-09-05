import * as zlib from 'node:zlib'
import { Universal } from 'koishi'
import type { BiliLiveBot } from './bot'
import { PendingGift, WSOperation, WSPacket } from './types'

export const WS_HEADER_LENGTH = 16

/** 小于该值视为秒级时间戳，自动换算为毫秒 */
const SECOND_VS_MS_BOUNDARY = 1e12

export function encodePacket(operation: WSOperation, body: Buffer = Buffer.alloc(0), protocolVersion = 1): Buffer {
  const header = Buffer.alloc(WS_HEADER_LENGTH)
  header.writeUInt32BE(WS_HEADER_LENGTH + body.length, 0)
  header.writeUInt16BE(WS_HEADER_LENGTH, 4)
  header.writeUInt16BE(protocolVersion, 6)
  header.writeUInt32BE(operation, 8)
  header.writeUInt32BE(1, 12)
  return Buffer.concat([header, body])
}

export function decodePackets(buffer: Buffer): WSPacket[] {
  const packets: WSPacket[] = []
  let offset = 0
  while (offset + WS_HEADER_LENGTH <= buffer.length) {
    const totalLength = buffer.readUInt32BE(offset)
    const headerLength = buffer.readUInt16BE(offset + 4)
    const protocolVersion = buffer.readUInt16BE(offset + 6)
    const operation = buffer.readUInt32BE(offset + 8) as WSOperation
    if (headerLength < WS_HEADER_LENGTH || totalLength < headerLength || offset + totalLength > buffer.length) {
      throw new Error(`非法 WebSocket 数据包：total=${totalLength}, header=${headerLength}`)
    }
    const body = buffer.subarray(offset + headerLength, offset + totalLength)
    if (operation === WSOperation.MESSAGE && protocolVersion === 2) {
      packets.push(...decodePackets(zlib.inflateSync(body)))
    } else if (operation === WSOperation.MESSAGE && protocolVersion === 3) {
      packets.push(...decodePackets(zlib.brotliDecompressSync(body)))
    } else {
      packets.push({ operation, protocolVersion, body })
    }
    offset += totalLength
  }
  if (offset !== buffer.length) throw new Error(`WebSocket 数据包尾部不完整：${buffer.length - offset} bytes`)
  return packets
}

/** 解析认证回复包中的 code，解析失败视为 0（协议保证回复为 JSON） */
export function readReplyCode(body: Buffer): number {
  try {
    return Number(JSON.parse(body.toString('utf8'))?.code ?? 0)
  } catch {
    return 0
  }
}

/** 把 B 站时间戳统一为毫秒：非法或缺失时回退当前时间，秒级自动升位 */
export function toMilliseconds(value: unknown, fallback = Date.now()): number {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return fallback
  return timestamp < SECOND_VS_MS_BOUNDARY ? timestamp * 1000 : timestamp
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** 构造直播间频道与群组信息（channel/guild 同为 `live:<roomId>`） */
export function roomScopes(bot: BiliLiveBot, roomId: number = bot.roomId) {
  const id = `live:${roomId}`
  return {
    channel: { id, type: Universal.Channel.Type.TEXT, name: bot.roomName },
    guild: { id, name: bot.roomName },
  }
}

/**
 * 礼物连击合并：同一 combo key 的礼物事件去抖聚合，静默 giftComboDuration 后
 * 以合并总数回调 dispatch。resolveTotal 用于计算累计数量（上游 combo 字段缺失时自行累加）。
 */
export function trackGiftCombo<T>(
  bot: BiliLiveBot,
  key: string,
  data: T,
  resolveTotal: (previous: number | undefined) => number,
  dispatch: (data: T, totalNum: number) => void,
): void {
  const existing = bot.pendingGifts.get(key)
  let entry: PendingGift<T>
  if (existing) {
    clearTimeout(existing.timer)
    existing.data = data
    existing.totalNum = resolveTotal(existing.totalNum)
    entry = existing as PendingGift<T>
  } else {
    entry = { data, totalNum: resolveTotal(undefined), timer: undefined }
    bot.pendingGifts.set(key, entry)
  }
  entry.timer = setTimeout(() => {
    bot.pendingGifts.delete(key)
    dispatch(entry.data, entry.totalNum)
  }, bot.config.giftComboDuration)
}
