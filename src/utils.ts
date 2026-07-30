import * as zlib from 'node:zlib'
import { WSOperation, WSPacket } from './types'

export const WS_HEADER_LENGTH = 16

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

export function toMilliseconds(value: unknown, fallback = Date.now()): number {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return fallback
  return timestamp < 1e12 ? timestamp * 1000 : timestamp
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
