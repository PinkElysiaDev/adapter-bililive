# adapter-biliLive 实现设计文档 v3

> 本文档为完整的实现设计参考，包含三种连接模式的详细架构、协议细节、事件映射和完整代码示例。
> 目标：任何 LLM 或开发者可以仅凭此文档完成完整实现，无需额外询问。

---

## 一、概述与模式选择

本插件支持三种运行模式，通过配置 `mode` 字段选择：

| 特性 | 开放平台模式 (open) | 混合模式 (hybrid) | Cookie Web 模式 (web) |
|------|---------------------|-------------------|----------------------|
| 接收认证 | access_key + access_secret + 主播身份码 | access_key + access_secret + 主播身份码 | Cookie |
| 发送认证 | 不支持发送 | Cookie + csrf | Cookie + csrf |
| 接收协议 | /v2/app/start → wss | /v2/app/start → wss | getDanmuInfo → wss |
| 事件格式 | LIVE_OPEN_PLATFORM_* | LIVE_OPEN_PLATFORM_* | DANMU_MSG/SEND_GIFT |
| 心跳机制 | WS 30s + HTTP 20s | WS 30s + HTTP 20s | WS 30s |
| 稳定性 | 高 | 接收稳定，发送依赖 Web API | 低 |
| 适用场景 | 仅监听事件 | 长期接收并回复指令 | 调试或无开放平台凭据 |

### 1.1 开放平台模式 (open)

- 使用 B站直播开放平台官方 API
- 认证流程：access_key + access_secret 生成 HMAC-SHA256 签名，携带主播身份码 (code) 调用 /v2/app/start
- 连接流程：/v2/app/start 返回 auth_body 和 wss_link[] → 连接 WebSocket
- 事件命名：`LIVE_OPEN_PLATFORM_DM`, `LIVE_OPEN_PLATFORM_SEND_GIFT` 等（前缀统一）
- 数据格式：`data.msg`, `data.uid`, `data.uname` 等扁平字段，结构稳定
- **双心跳机制**（关键！）：
  - WS 心跳：每 30s 发送 Action=2 包，body = auth_body 字符串
  - HTTP 平台心跳：每 20s POST `/v2/app/heartbeat`，body = `{game_id}`
  - 若 HTTP 心跳缺失超过 60s，B站服务器主动断开 WS 连接
- 会话结束信号：收到 `LIVE_OPEN_PLATFORM_INTERACTION_END` → 需重新 /v2/app/start

### 1.2 Cookie Web 模式 (web)

- 使用传统 Web 弹幕 WebSocket 协议（与浏览器 F12 中看到的相同）
- 认证：Cookie 中的 SESSDATA + bili_jct + DedeUserID，部分接口需 WBI 签名
- 连接流程：调用 getDanmuInfo 获取 token + host_list → 连接 WebSocket
- 事件命名：`DANMU_MSG`, `SEND_GIFT`, `SUPER_CHAT_MESSAGE` 等
- 数据格式：info 数组（如 `info[1]` 为弹幕文本，`info[2][0]` 为 UID），格式不稳定
- **单心跳**：WS 心跳每 30s，body 为空
- 无 HTTP 平台心跳要求
- ⚠️ 此模式随时可能因 B站前端接口变更而失效，仅建议个人调试使用

### 1.3 混合模式 (hybrid)

- 接收链路与 `open` 完全相同，使用开放平台 `/v2/app/start`、WSS 和双心跳
- 发送链路单独创建 `WebHttpApi`，仅通过 Cookie 和 CSRF 调用网页端 `/msg/send`
- 不使用 Cookie 建立 Web 弹幕长连接，因此不会重复接收同一条弹幕
- 启动时校验发送账号 Cookie 登录态，并检查登录 UID 与 `DedeUserID` 一致
- 开放平台返回真实房间号后，同步更新 Web 发送目标
- 适合需要稳定接收 Koishi 指令并把回复发送回直播间的场景
- ⚠️ 发送接口不是直播开放平台 API，仍可能受到 Cookie 过期、限频和账号风控影响

---

## 二、项目文件结构

```
src/
├── index.ts                 # 插件入口，导出 name/Config/apply
├── adapter.ts               # BiliLiveAdapter extends Adapter
├── bot.ts                   # BiliLiveBot extends Bot
├── message.ts               # MessageEncoder（弹幕文本发送）
├── types.ts                 # 所有 TypeScript 类型/接口定义
├── config.ts                # 配置 Schema（Koishi Schema DSL）
├── utils.ts                 # 二进制协议编解码 + 通用工具
├── open/                    # ======= 开放平台模式 =======
│   ├── auth.ts             # HMAC-SHA256 签名算法
│   ├── ws-client.ts        # WS 长连接 (/v2/app/start + wss + 双心跳)
│   ├── http-api.ts         # 开放平台 REST API 封装
│   └── events.ts           # LIVE_OPEN_PLATFORM_* → Koishi Session
└── web/                     # ======= Cookie Web 模式 =======
    ├── auth.ts             # Cookie 注入 + WBI 签名算法
    ├── ws-client.ts        # getDanmuInfo + wss 连接 + 单心跳
    ├── http-api.ts         # Web API (cookie + csrf)
    └── events.ts           # DANMU_MSG/SEND_GIFT → Koishi Session
```

---

## 三、配置 Schema (config.ts)

### 3.1 完整配置接口

```typescript
import { Schema } from 'koishi'

export interface OpenPlatformCredential {
  appId: number                    // 开放平台应用 ID
  accessKey: string                // access_key_id
  accessSecret: string             // access_key_secret
  code: string                     // 主播身份码（主播在开放平台获取）
}

export interface WebCredential {
  sessdata: string                 // Cookie: SESSDATA
  biliJct: string                  // Cookie: bili_jct (即 csrf token)
  dedeUserId: string               // Cookie: DedeUserID
  buvid3: string                   // Cookie: buvid3
}

export interface OpenModeConfig extends OpenPlatformCredential {
  mode: 'open'
}

export interface HybridModeConfig extends OpenPlatformCredential {
  mode: 'hybrid'
  credential: WebCredential
}

export interface WebModeConfig {
  mode: 'web'
  credential: WebCredential
}

export interface CommonConfig {
  roomId: number                   // 直播间房间号（短号或真实号均可）
  uid: number                      // 主播 UID
  sendInterval: number             // 弹幕发送间隔 ms，默认 1000
  maxDanmakuLength: number         // 单条弹幕最大字符数，默认 20
  enableGift: boolean              // 是否处理礼物事件，默认 true
  giftComboDuration: number        // 礼物连击合并等待时间 ms，默认 3000
  enableEntry: boolean             // 是否处理入场事件，默认 false（量大）
  enableLike: boolean              // 是否处理点赞事件，默认 false（量大）
  heartbeatInterval: number        // WS 心跳间隔 ms，默认 30000
  maxReconnectAttempts: number     // 最大重连次数，默认 5
  reconnectInterval: number        // 重连间隔基数 ms，默认 3000
}

export type BiliLiveConfig = (OpenModeConfig | HybridModeConfig | WebModeConfig) & CommonConfig
```

### 3.2 Schema 定义（使用 Schema.intersect + Schema.union 实现模式判别）

```typescript
export const Config: Schema<BiliLiveConfig> = Schema.intersect([
  Schema.union([
    Schema.object({
      mode: Schema.const('open').required().description('开放平台模式'),
      appId: Schema.number().required().description('开放平台应用 ID'),
      accessKey: Schema.string().required().role('secret').description('access_key_id'),
      accessSecret: Schema.string().required().role('secret').description('access_key_secret'),
      code: Schema.string().required().description('主播身份码'),
    }).description('开放平台模式'),
    Schema.object({
      mode: Schema.const('hybrid').required().description('混合模式'),
      appId: Schema.number().required().description('开放平台应用 ID'),
      accessKey: Schema.string().required().role('secret').description('access_key_id'),
      accessSecret: Schema.string().required().role('secret').description('access_key_secret'),
      code: Schema.string().required().role('secret').description('主播身份码'),
      credential: Schema.object({
        sessdata: Schema.string().required().role('secret').description('发送账号 SESSDATA'),
        biliJct: Schema.string().required().role('secret').description('发送账号 bili_jct'),
        dedeUserId: Schema.string().required().description('发送账号 DedeUserID'),
        buvid3: Schema.string().required().description('发送账号 buvid3'),
      }).description('仅用于发送弹幕的 Cookie 凭据'),
    }).description('混合模式'),
    Schema.object({
      mode: Schema.const('web').required().description('Cookie Web 模式'),
      credential: Schema.object({
        sessdata: Schema.string().required().role('secret').description('SESSDATA'),
        biliJct: Schema.string().required().role('secret').description('bili_jct'),
        dedeUserId: Schema.string().required().description('DedeUserID'),
        buvid3: Schema.string().required().description('buvid3'),
      }).description('Cookie 凭据'),
    }).description('Cookie Web 模式'),
  ]),
  Schema.object({
    roomId: Schema.number().required().description('直播间房间号'),
    uid: Schema.number().required().description('主播 UID'),
    sendInterval: Schema.number().default(1000).description('弹幕发送间隔 (ms)'),
    maxDanmakuLength: Schema.number().default(20).description('单条弹幕最大长度'),
    enableGift: Schema.boolean().default(true).description('接收礼物事件'),
    giftComboDuration: Schema.number().default(3000).description('礼物连击合并时间 (ms)'),
    enableEntry: Schema.boolean().default(false).description('接收入场事件'),
    enableLike: Schema.boolean().default(false).description('接收点赞事件'),
    heartbeatInterval: Schema.number().default(30000).description('WS 心跳间隔 (ms)'),
    maxReconnectAttempts: Schema.number().default(5).description('最大重连次数'),
    reconnectInterval: Schema.number().default(3000).description('重连间隔 (ms)'),
  }).description('通用配置'),
]) as any
```

---

## 四、开放平台签名算法 (open/auth.ts)

### 4.1 签名流程

1. 构造 header 字典（按 key 字母序排列）
2. 将 header 拼接为 `key:value\nkey:value...` 格式字符串
3. 使用 access_secret 作为 HMAC-SHA256 密钥对拼接字符串签名
4. 签名结果作为 Authorization header 的值

### 4.2 完整实现

```typescript
import crypto from 'crypto'

/**
 * 为开放平台 API 请求生成签名 headers
 * 参考: js-demo/server/tool/index.ts
 */
export function getOpenPlatformHeaders(
  params: object,
  accessKey: string,
  accessSecret: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const nonce = Math.floor(Math.random() * 100000) + timestamp

  // 固定 header 字段（按 key 字母序排列）
  const header: Record<string, string> = {
    'x-bili-accesskeyid': accessKey,
    'x-bili-content-md5': crypto.createHash('md5')
      .update(JSON.stringify(params))
      .digest('hex'),
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': String(nonce),
    'x-bili-signature-version': '1.0',
    'x-bili-timestamp': String(timestamp),
  }

  // 拼接为 key:value\n 格式（已按字母序）
  const data = Object.entries(header)
    .map(([k, v]) => `${k}:${v}`)
    .join('\n')

  // HMAC-SHA256 签名
  const signature = crypto.createHmac('sha256', accessSecret)
    .update(data)
    .digest('hex')

  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...header,
    'Authorization': signature,
  }
}
```

### 4.3 签名验证示例

给定：
- accessKey = `"abc123"`
- accessSecret = `"secret456"`
- params = `{"code": "ABCDEF", "app_id": 12345}`

签名过程：
1. content-md5 = MD5(JSON.stringify(params))
2. 拼接字符串 = 各 x-bili-* header 按 key 排序后 join(\n)
3. signature = HMAC-SHA256(accessSecret, 拼接字符串).hex()

---

## 五、开放平台长连接 (open/ws-client.ts)

### 5.1 连接流程概览

```
┌─────────┐     POST /v2/app/start      ┌──────────────────┐
│  Plugin │ ──────────────────────────→  │ B站开放平台 API  │
│         │ ←────────────────────────── │                  │
└────┬────┘   {auth_body, wss_link[]}    └──────────────────┘
     │
     │  Connect wss_link[0]
     ▼
┌─────────┐     Auth Packet (op=7)       ┌──────────────────┐
│   WS    │ ──────────────────────────→  │ B站 WS 服务器    │
│ Client  │ ←────────────────────────── │                  │
└────┬────┘   Auth Reply (op=8)          └──────────────────┘
     │
     │  Start dual heartbeat
     ▼
  ┌──────────────────────────────────────────┐
  │ WS Heartbeat: 每 30s, op=2, body=auth_body │
  │ HTTP Heartbeat: 每 20s, POST /v2/app/heartbeat │
  └──────────────────────────────────────────┘
```

### 5.2 /v2/app/start 请求与响应

**请求：**
```typescript
// POST https://live-open.biliapi.com/v2/app/start
const body = { code: config.code, app_id: config.appId }
const headers = getOpenPlatformHeaders(body, config.accessKey, config.accessSecret)
const resp = await ctx.http.post(
  'https://live-open.biliapi.com/v2/app/start',
  body,
  { headers }
)
```

**响应结构 (resp.data)：**
```typescript
interface AppStartResponse {
  code: number           // 0=成功
  message: string
  data: {
    anchor_info: {
      room_id: number
      uid: number
      uname: string
      uface: string      // 头像 URL
    }
    game_info: {
      game_id: string    // 重要！用于心跳和结束会话
    }
    websocket_info: {
      auth_body: string  // JSON 字符串，直接作为 auth 包的 body
      wss_link: string[] // WebSocket 地址列表（按优先级排序）
    }
  }
}
```

**auth_body 内容示例（JSON 字符串）：**
```json
{
  "roomid": 12345,
  "uid": 0,
  "protover": 3,
  "key": "xxxxxxxxxxxxxxxx",
  "group": "open"
}
```

> ⚠️ 注意：auth_body 是一个 **JSON 字符串**，直接作为 WS auth 包和心跳包的 body 发送，不要二次 parse/stringify。

### 5.3 WebSocket 连接与认证

```typescript
import { WebSocket } from 'ws'  // 或使用 ctx.http.ws()

class OpenWSClient {
  private ws: WebSocket
  private authBody: string
  private gameId: string
  private wsHeartbeatTimer: NodeJS.Timer
  private httpHeartbeatTimer: NodeJS.Timer
  private wssLinks: string[]
  private currentLinkIndex = 0

  async connect() {
    // 1. 调用 /v2/app/start
    const resp = await this.callAppStart()
    this.authBody = resp.data.websocket_info.auth_body
    this.gameId = resp.data.game_info.game_id
    this.wssLinks = resp.data.websocket_info.wss_link

    // 2. 连接 WebSocket
    this.ws = ctx.http.ws(this.wssLinks[this.currentLinkIndex])

    this.ws.on('open', () => {
      // 3. 发送 auth 包: operation=7, body=authBody
      const authPacket = encodePacket(
        WSOperation.AUTH,
        Buffer.from(this.authBody, 'utf-8')
      )
      this.ws.send(authPacket)
    })

    this.ws.on('message', (raw: Buffer) => {
      const packets = decodePackets(raw)
      for (const pkt of packets) {
        this.handlePacket(pkt)
      }
    })

    this.ws.on('close', () => this.handleDisconnect())
    this.ws.on('error', (err) => this.handleError(err))
  }

  private handlePacket(pkt: { operation: number; body: Buffer }) {
    switch (pkt.operation) {
      case WSOperation.AUTH_REPLY:
        // 认证成功，启动双心跳
        this.startDualHeartbeat()
        break
      case WSOperation.HEARTBEAT_REPLY:
        // 心跳回复，body 为 4 字节大端 int（人气值），可忽略
        break
      case WSOperation.MESSAGE:
        // 业务消息
        const msg = JSON.parse(pkt.body.toString('utf-8'))
        this.handleCommand(msg)
        break
    }
  }
}
```

### 5.4 双心跳机制（关键实现细节）

```typescript
private startDualHeartbeat() {
  // === WS 心跳：每 30s ===
  this.wsHeartbeatTimer = setInterval(() => {
    // 开放平台的 WS 心跳 body 是 auth_body 字符串（非空！）
    const heartbeatPacket = encodePacket(
      WSOperation.HEARTBEAT,
      Buffer.from(this.authBody, 'utf-8')
    )
    this.ws.send(heartbeatPacket)
  }, 30000)

  // === HTTP 平台心跳：每 20s ===
  this.httpHeartbeatTimer = setInterval(async () => {
    try {
      const body = { game_id: this.gameId }
      const headers = getOpenPlatformHeaders(
        body, this.config.accessKey, this.config.accessSecret
      )
      await ctx.http.post(
        'https://live-open.biliapi.com/v2/app/heartbeat',
        body,
        { headers }
      )
    } catch (err) {
      this.logger.warn('HTTP heartbeat failed:', err)
      // HTTP 心跳失败 → 强制断开重连
      this.forceReconnect()
    }
  }, 20000)
}
```

> ⚠️ **开放平台 vs Web 模式心跳区别**：
> - 开放平台 WS 心跳 body = auth_body 字符串（有内容）
> - Web 模式 WS 心跳 body = 空（Buffer.alloc(0) 或空字符串）
> - 开放平台需要额外的 HTTP 心跳（Web 模式不需要）

### 5.5 二进制包格式（两种模式共用）

所有 WebSocket 通信使用统一的二进制协议，16 字节定长 header + 变长 body：

| 偏移 | 长度 | 类型 | 字段 | 说明 |
|------|------|------|------|------|
| 0 | 4 | uint32 BE | totalLength | 整包长度 = headerLen + bodyLen |
| 4 | 2 | uint16 BE | headerLength | 固定 16 |
| 6 | 2 | uint16 BE | protover | 协议版本：0/1=raw, 2=zlib, 3=brotli |
| 8 | 4 | uint32 BE | operation | 操作码（见下表） |
| 12 | 4 | uint32 BE | sequence | 序列号（通常为 1） |
| 16 | - | bytes | body | 正文数据 |

**Operation 操作码：**

| 值 | 名称 | 方向 | 说明 |
|----|------|------|------|
| 2 | HEARTBEAT | Client→Server | 心跳包 |
| 3 | HEARTBEAT_REPLY | Server→Client | 心跳回复（body: 4字节人气值） |
| 5 | MESSAGE | Server→Client | 业务消息（弹幕/礼物等） |
| 7 | AUTH | Client→Server | 认证包 |
| 8 | AUTH_REPLY | Server→Client | 认证回复 |

**Protover 处理：**
- protover=0 或 1：body 直接为 JSON 文本
- protover=2：body 使用 zlib deflate 压缩，解压后可能包含多个包（递归解析）
- protover=3：body 使用 brotli 压缩，解压后可能包含多个包（递归解析）

### 5.6 编解码实现 (utils.ts)

```typescript
import { inflate } from 'zlib'
import { brotliDecompressSync } from 'zlib'

export enum WSOperation {
  HEARTBEAT = 2,
  HEARTBEAT_REPLY = 3,
  MESSAGE = 5,
  AUTH = 7,
  AUTH_REPLY = 8,
}

const WS_HEADER_LENGTH = 16

export interface WSPacket {
  operation: WSOperation
  body: Buffer
}

/** 编码单个 WS 包 */
export function encodePacket(operation: WSOperation, body: Buffer): Buffer {
  const totalLength = WS_HEADER_LENGTH + body.length
  const header = Buffer.alloc(WS_HEADER_LENGTH)
  header.writeUInt32BE(totalLength, 0)
  header.writeUInt16BE(WS_HEADER_LENGTH, 4)
  header.writeUInt16BE(1, 6)  // protover = 1 for outgoing
  header.writeUInt32BE(operation, 8)
  header.writeUInt32BE(1, 12) // sequence = 1
  return Buffer.concat([header, body])
}

/** 解码 WS 数据（可能含多包 + 压缩） */
export function decodePackets(raw: Buffer): WSPacket[] {
  const packets: WSPacket[] = []
  let offset = 0

  while (offset < raw.length) {
    const totalLength = raw.readUInt32BE(offset)
    const headerLength = raw.readUInt16BE(offset + 4)
    const protover = raw.readUInt16BE(offset + 6)
    const operation = raw.readUInt32BE(offset + 8) as WSOperation
    const body = raw.slice(offset + headerLength, offset + totalLength)

    if (protover === 2) {
      // zlib deflate，解压后递归解析
      const inflated = require("zlib").inflateSync(body)
      packets.push(...decodePackets(inflated))
    } else if (protover === 3) {
      // brotli，解压后递归解析
      const decompressed = brotliDecompressSync(body)
      packets.push(...decodePackets(decompressed))
    } else {
      packets.push({ operation, body })
    }

    offset += totalLength
  }

  return packets
}
```

### 5.7 重连策略

- WS 非正常关闭 → 指数退避重连（baseInterval * 2^attempt），最多 maxReconnectAttempts 次
- wss_link 轮转：若 wss_link[0] 连接失败，尝试 wss_link[1]，依次轮转
- 收到 `LIVE_OPEN_PLATFORM_INTERACTION_END` → 会话已结束，必须重新调用 /v2/app/start（不是简单重连 WS）
- /v2/app/start 返回错误码 → 检查是否为 code 过期，若是则 emit `bililive/code-expired` 事件并停止重试

```typescript
private async handleDisconnect() {
  this.stopHeartbeats()

  if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
    this.logger.error('Max reconnect attempts reached')
    this.bot.status = 'offline'
    return
  }

  this.reconnectAttempts++
  const delay = this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1)
  this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

  await new Promise(resolve => setTimeout(resolve, delay))

  // 尝试下一个 wss_link
  this.currentLinkIndex = (this.currentLinkIndex + 1) % this.wssLinks.length

  try {
    await this.connect()
    this.reconnectAttempts = 0
  } catch (err) {
    this.handleDisconnect()
  }
}
```

### 5.8 会话结束与清理

```typescript
/** 主动结束会话 */
async stop() {
  this.stopHeartbeats()

  // 通知 B站 结束会话
  if (this.gameId) {
    try {
      const body = { game_id: this.gameId, app_id: this.config.appId }
      const headers = getOpenPlatformHeaders(
        body, this.config.accessKey, this.config.accessSecret
      )
      await ctx.http.post(
        'https://live-open.biliapi.com/v2/app/end',
        body,
        { headers }
      )
    } catch (err) {
      this.logger.warn('Failed to call /v2/app/end:', err)
    }
  }

  // 关闭 WebSocket
  if (this.ws) {
    this.ws.close()
  }
}
```

---

## 六、开放平台事件映射 (open/events.ts)

所有开放平台事件的 cmd 字段以 `LIVE_OPEN_PLATFORM_` 开头，data 为扁平 object。

### 6.1 LIVE_OPEN_PLATFORM_DM → Session (type: message)

**原始数据结构：**
```typescript
interface OpenDMData {
  msg: string              // 弹幕内容
  uid: number              // 发送者 UID
  uname: string            // 发送者昵称
  uface: string            // 发送者头像 URL
  guard_level: number      // 0=无, 1=总督, 2=提督, 3=舰长
  timestamp: number        // 时间戳（秒）
  msg_id: string           // 消息唯一 ID
  room_id: number          // 直播间 ID
  open_id: string          // 开放平台用户唯一标识
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
}
```

**Session 构造：**
```typescript
import { h, Session } from 'koishi'

function handleOpenDM(data: OpenDMData, bot: BiliLiveBot): Session {
  const session = bot.session({
    type: 'message',
    channel: {
      id: `live:${data.room_id}`,
      type: Session.Channel.Type.TEXT,
    },
    user: {
      id: String(data.uid),
      name: data.uname,
      avatar: data.uface,
    },
    message: {
      id: data.msg_id,
      content: data.msg,
      elements: [h.text(data.msg)],
    },
    timestamp: data.timestamp * 1000,
  })

  // 同时 emit 自定义事件，携带完整元数据
  bot.dispatch(bot.session({
    type: 'bililive/danmaku',
    ...data,
  } as any))

  return session
}
```

### 6.2 LIVE_OPEN_PLATFORM_SEND_GIFT → Session (type: bililive-gift)

**原始数据结构：**
```typescript
interface OpenGiftData {
  uid: number
  uname: string
  uface: string
  gift_id: number           // 礼物 ID
  gift_name: string         // 礼物名称
  gift_num: number          // 礼物数量
  price: number             // 单价（金瓜子/银瓜子）
  paid: boolean             // 是否付费礼物
  guard_level: number
  timestamp: number
  msg_id: string
  room_id: number
  open_id: string
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
  combo_id: string          // 连击 ID（用于合并同一连击）
  combo_num: number         // 连击数
}
```

**Session 构造（含连击合并逻辑）：**
```typescript
// 礼物连击合并 pending map
private pendingGifts = new Map<string, {
  data: OpenGiftData
  timer: NodeJS.Timeout
  totalNum: number
}>()

function handleOpenGift(data: OpenGiftData, bot: BiliLiveBot) {
  const key = data.combo_id || `${data.uid}_${data.gift_id}_${data.timestamp}`

  const existing = this.pendingGifts.get(key)
  if (existing) {
    // 更新连击数量
    existing.totalNum = data.combo_num || existing.totalNum + data.gift_num
    existing.data = data
    clearTimeout(existing.timer)
  } else {
    this.pendingGifts.set(key, {
      data,
      totalNum: data.gift_num,
      timer: null!,
    })
  }

  // 设置合并超时
  const entry = this.pendingGifts.get(key)!
  entry.timer = setTimeout(() => {
    this.pendingGifts.delete(key)
    this.emitGiftSession(entry.data, entry.totalNum, bot)
  }, this.config.giftComboDuration)
}

function emitGiftSession(data: OpenGiftData, totalNum: number, bot: BiliLiveBot) {
  const session = bot.session({
    type: 'bililive-gift' as any,
    channel: {
      id: `live:${data.room_id}`,
      type: Session.Channel.Type.TEXT,
    },
    user: {
      id: String(data.uid),
      name: data.uname,
      avatar: data.uface,
    },
    message: {
      id: data.msg_id,
      content: `[礼物] ${data.gift_name} x${totalNum}`,
      elements: [h('bililive:gift', {
        giftId: data.gift_id,
        giftName: data.gift_name,
        giftNum: totalNum,
        price: data.price,
        paid: data.paid,
      })],
    },
    timestamp: data.timestamp * 1000,
  })

  bot.dispatch(session)
  bot.dispatch(bot.session({ type: 'bililive/gift', ...data, gift_num: totalNum } as any))
}
```

### 6.3 LIVE_OPEN_PLATFORM_SUPER_CHAT → Session (type: bililive-superchat)

**原始数据结构：**
```typescript
interface OpenSuperChatData {
  uid: number
  uname: string
  uface: string
  message: string           // SC 内容
  rmb: number               // 金额（人民币）
  start_time: number        // 开始时间戳
  end_time: number          // 结束时间戳
  msg_id: string
  room_id: number
  open_id: string
  guard_level: number
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
}
```

**Session 构造：**
```typescript
function handleOpenSuperChat(data: OpenSuperChatData, bot: BiliLiveBot) {
  const session = bot.session({
    type: 'bililive-superchat' as any,
    channel: {
      id: `live:${data.room_id}`,
      type: Session.Channel.Type.TEXT,
    },
    user: {
      id: String(data.uid),
      name: data.uname,
      avatar: data.uface,
    },
    message: {
      id: `sc_${data.msg_id}`,
      content: data.message,
      elements: [
        h('bililive:superchat', {
          price: data.rmb,
          duration: data.end_time - data.start_time,
          message: data.message,
        }),
      ],
    },
    timestamp: data.start_time * 1000,
  })

  bot.dispatch(session)
  bot.dispatch(bot.session({
    type: 'bililive/superchat',
    ...data,
    duration: data.end_time - data.start_time,
  } as any))
}
```

### 6.4 LIVE_OPEN_PLATFORM_GUARD → Session (type: bililive-guard)

**原始数据结构：**
```typescript
interface OpenGuardData {
  user_info: {
    uid: number
    uname: string
    uface: string
  }
  guard_level: number       // 1=总督, 2=提督, 3=舰长
  guard_num: number         // 开通数量（月数）
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
  room_id: number
  msg_id: string
  timestamp: number
}
```

**Guard level 映射：**

| guard_level | 名称 | 说明 |
|-------------|------|------|
| 1 | 总督 | 最高等级 |
| 2 | 提督 | 中间等级 |
| 3 | 舰长 | 最低等级 |

**Session 构造：**
```typescript
const GUARD_NAMES = { 1: '总督', 2: '提督', 3: '舰长' } as const

function handleOpenGuard(data: OpenGuardData, bot: BiliLiveBot) {
  const guardName = GUARD_NAMES[data.guard_level] || `等级${data.guard_level}`
  const session = bot.session({
    type: 'bililive-guard' as any,
    channel: {
      id: `live:${data.room_id}`,
      type: Session.Channel.Type.TEXT,
    },
    user: {
      id: String(data.user_info.uid),
      name: data.user_info.uname,
      avatar: data.user_info.uface,
    },
    message: {
      id: data.msg_id,
      content: `[上舰] ${data.user_info.uname} 开通 ${guardName} x${data.guard_num}`,
      elements: [h('bililive:guard', {
        guardLevel: data.guard_level,
        guardName,
        guardNum: data.guard_num,
      })],
    },
    timestamp: data.timestamp * 1000,
  })

  bot.dispatch(session)
  bot.dispatch(bot.session({ type: 'bililive/guard', ...data } as any))
}
```

### 6.5 LIVE_OPEN_PLATFORM_LIKE → 点赞事件（条件触发）

```typescript
interface OpenLikeData {
  uid: number
  uname: string
  uface: string
  timestamp: number
  room_id: number
  like_text: string         // "为主播点赞了"
  like_count: number        // 点赞次数
}

function handleOpenLike(data: OpenLikeData, bot: BiliLiveBot) {
  if (!this.config.enableLike) return

  bot.dispatch(bot.session({
    type: 'bililive/like',
    userId: String(data.uid),
    userName: data.uname,
    userAvatar: data.uface,
    likeCount: data.like_count,
    roomId: data.room_id,
    timestamp: data.timestamp * 1000,
  } as any))
}
```

### 6.6 LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER → 入场事件（条件触发）

```typescript
interface OpenEnterData {
  uid: number
  uname: string
  uface: string
  timestamp: number
  room_id: number
}

function handleOpenEnter(data: OpenEnterData, bot: BiliLiveBot) {
  if (!this.config.enableEntry) return

  bot.dispatch(bot.session({
    type: 'bililive/enter',
    userId: String(data.uid),
    userName: data.uname,
    userAvatar: data.uface,
    roomId: data.room_id,
    timestamp: data.timestamp * 1000,
  } as any))
}
```

### 6.7 其他事件

| CMD | 处理方式 | 说明 |
|-----|----------|------|
| OPEN_LIVEROOM_INTERACT_WORD | emit `bililive/follow` | 关注事件 |
| OPEN_LIVEROOM_WARNING | emit `bililive/warning` | 超管警告 |
| LIVE_OPEN_PLATFORM_INTERACTION_END | 触发重连流程 | 会话结束，需重新 /v2/app/start |

```typescript
// 事件分发主入口
private handleCommand(msg: { cmd: string; data: any }) {
  switch (msg.cmd) {
    case 'LIVE_OPEN_PLATFORM_DM':
      this.handleOpenDM(msg.data)
      break
    case 'LIVE_OPEN_PLATFORM_SEND_GIFT':
      this.handleOpenGift(msg.data)
      break
    case 'LIVE_OPEN_PLATFORM_SUPER_CHAT':
      this.handleOpenSuperChat(msg.data)
      break
    case 'LIVE_OPEN_PLATFORM_GUARD':
      this.handleOpenGuard(msg.data)
      break
    case 'LIVE_OPEN_PLATFORM_LIKE':
      this.handleOpenLike(msg.data)
      break
    case 'LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER':
      this.handleOpenEnter(msg.data)
      break
    case 'LIVE_OPEN_PLATFORM_INTERACTION_END':
      this.logger.info('Session ended, restarting...')
      this.reconnectFromStart()
      break
    case 'OPEN_LIVEROOM_INTERACT_WORD':
      bot.dispatch(bot.session({ type: 'bililive/follow', ...msg.data } as any))
      break
    case 'OPEN_LIVEROOM_WARNING':
      bot.dispatch(bot.session({ type: 'bililive/warning', msg: msg.data.msg, roomId: msg.data.room_id } as any))
      break
    default:
      this.logger.debug('Unknown command:', msg.cmd)
  }
}
```

---

## 七、Cookie Web 签名 (web/auth.ts)

### 7.1 WBI 签名算法

WBI 签名用于部分 Web API（如 getDanmuInfo），算法如下：

1. 获取 `wbi_img` 的 `img_url` 和 `sub_url`（从 nav 接口）
2. 提取两个 URL 的文件名（去掉扩展名），拼接为 raw_wbi_key
3. 使用 MIXIN_KEY_ENC_TAB 重排列 raw_wbi_key 取前 32 位作为 mixin_key
4. 将请求参数按 key 排序，加入 wts（当前时间戳）和 w_rid
5. w_rid = MD5(排序后的 query_string + mixin_key)

```typescript
// WBI 混淆 key 编码表（固定值）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

function getMixinKey(rawKey: string): string {
  return MIXIN_KEY_ENC_TAB.map(i => rawKey[i]).join('').slice(0, 32)
}

export function signWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
): Record<string, string | number> {
  const mixinKey = getMixinKey(imgKey + subKey)
  const wts = Math.floor(Date.now() / 1000)
  const newParams = { ...params, wts }

  // 按 key 排序
  const sorted = Object.keys(newParams)
    .sort()
    .map(k => `${k}=${encodeURIComponent(newParams[k])}`)
    .join('&')

  const wRid = crypto.createHash('md5')
    .update(sorted + mixinKey)
    .digest('hex')

  return { ...newParams, w_rid: wRid }
}
```

### 7.2 Cookie 注入

```typescript
export function getCookieHeader(credential: WebModeConfig["credential"]): string {
  return [
    `SESSDATA=${credential.sessdata}`,
    `bili_jct=${credential.biliJct}`,
    `DedeUserID=${credential.dedeUserId}`,
    `buvid3=${credential.buvid3}`,
  ].join('; ')
}

export function getWebHeaders(credential: WebModeConfig["credential"]): Record<string, string> {
  return {
    'Cookie': getCookieHeader(credential),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://live.bilibili.com',
    'Referer': 'https://live.bilibili.com/',
  }
}
```

### 7.3 获取 WBI Keys

```typescript
export async function getWbiKeys(ctx: Context, credential: WebModeConfig["credential"]) {
  const resp = await ctx.http.get('https://api.bilibili.com/x/web-interface/nav', {
    headers: getWebHeaders(credential),
  })
  const { img_url, sub_url } = resp.data.wbi_img
  const imgKey = img_url.split('/').pop()!.split('.')[0]
  const subKey = sub_url.split('/').pop()!.split('.')[0]
  return { imgKey, subKey }
}
```

---

## 八、Cookie Web 长连接 (web/ws-client.ts)

### 8.1 连接流程

1. 调用 `getDanmuInfo` 获取 WebSocket token 和 host 列表
2. 连接 `wss://{host}:{wss_port}/sub`
3. 发送 auth 包（JSON object，非字符串）
4. 收到 auth_reply 后启动心跳

### 8.2 getDanmuInfo 接口

```typescript
async function getDanmuInfo(ctx: Context, roomId: number, credential?: WebModeConfig["credential"]) {
  const params: Record<string, any> = { id: roomId, type: 0 }

  let headers: Record<string, string> = {}
  if (credential) {
    // 有 cookie 时使用 WBI 签名
    const { imgKey, subKey } = await getWbiKeys(ctx, credential)
    const signedParams = signWbi(params, imgKey, subKey)
    const query = Object.entries(signedParams).map(([k, v]) => `${k}=${v}`).join('&')
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`
    headers = getWebHeaders(credential)
    return await ctx.http.get(url, { headers })
  } else {
    // 匿名模式（无 cookie）
    return await ctx.http.get('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo', {
      params,
    })
  }
}
```

**响应结构：**
```typescript
interface DanmuInfoResponse {
  code: number
  data: {
    token: string            // WebSocket 认证 key
    host_list: Array<{
      host: string
      port: number
      wss_port: number
      ws_port: number
    }>
  }
}
```

### 8.3 WebSocket 连接与认证

```typescript
class WebWSClient {
  async connect() {
    const info = await getDanmuInfo(this.ctx, this.config.roomId, this.config.credential)
    const { token, host_list } = info.data

    // 选择第一个 host
    const host = host_list[0]
    const wsUrl = `wss://${host.host}:${host.wss_port}/sub`

    this.ws = this.ctx.http.ws(wsUrl)

    this.ws.on('open', () => {
      // Auth 包 body 是 JSON object（不是字符串！）
      const authBody = JSON.stringify({
        uid: Number(this.config.credential?.dedeUserId || 0),
        roomid: this.config.roomId,
        protover: 3,        // 请求 brotli 压缩
        key: token,
        platform: 'web',
        type: 2,
        buvid: this.config.credential?.buvid3 || '',
      })

      const authPacket = encodePacket(
        WSOperation.AUTH,
        Buffer.from(authBody, 'utf-8')
      )
      this.ws.send(authPacket)
    })

    this.ws.on('message', (raw: Buffer) => {
      const packets = decodePackets(raw)
      for (const pkt of packets) {
        this.handlePacket(pkt)
      }
    })

    this.ws.on('close', () => this.handleDisconnect())
    this.ws.on('error', (err) => this.handleError(err))
  }

  private startHeartbeat() {
    // Web 模式心跳：body 为空
    this.heartbeatTimer = setInterval(() => {
      const heartbeatPacket = encodePacket(
        WSOperation.HEARTBEAT,
        Buffer.alloc(0)  // 空 body！
      )
      this.ws.send(heartbeatPacket)
    }, this.config.heartbeatInterval)
  }
}
```

### 8.4 与开放平台模式的关键区别

| 特性 | 开放平台 (open) | Web 模式 (web) |
|------|-----------------|----------------|
| Auth body | auth_body 字符串（原样使用） | JSON object（自行构造） |
| 心跳 body | auth_body 字符串 | 空 (Buffer.alloc(0)) |
| HTTP 心跳 | 需要（每 20s） | 不需要 |
| protover 请求 | 由服务器决定（auth_body 中） | 客户端请求 protover:3 |
| 重连触发 | INTERACTION_END → /v2/app/start | WS 断开 → getDanmuInfo → 重连 |

---

## 九、Cookie Web 事件映射 (web/events.ts)

Web 模式的事件使用传统弹幕协议的 CMD 名称，数据格式为嵌套数组或 object。

### 9.1 DANMU_MSG → Session (type: message)

> ⚠️ `DANMU_MSG` 可能有后缀如 `DANMU_MSG:4:0:2:2:2:0`，使用 `cmd.startsWith("DANMU_MSG")` 匹配。

**数据结构（info 数组）：**
```typescript
// msg.info 是一个嵌套数组
// info[0]: 元信息数组
//   info[0][4]: 时间戳 (ms)
//   info[0][9]: { mode, extra } (JSON 字符串，含 msg_id 等)
// info[1]: 弹幕文本内容
// info[2]: 用户信息数组
//   info[2][0]: UID (number，可能超过 2^53，需 String())
//   info[2][1]: 用户名
// info[3]: 粉丝勋章信息
//   info[3][1]: 勋章名
//   info[3][0]: 勋章等级
// info[7]: 大航海等级 (0=无, 1=总督, 2=提督, 3=舰长)
```

**Session 构造：**
```typescript
function handleDanmuMsg(msg: any, bot: BiliLiveBot) {
  const info = msg.info
  const text = info[1] as string
  const uid = String(info[2][0])  // 注意：转字符串（UID 可能为大数）
  const uname = info[2][1] as string

  // 获取 msg_id（从 info[0][9] 的 JSON 中）
  let msgId: string
  try {
    const extra = typeof info[0][9] === 'object' ? info[0][9] : JSON.parse(info[0][9]?.extra || '{}')
    msgId = extra.msg_id || `dm_${uid}_${info[0][4]}`
  } catch {
    msgId = `dm_${uid}_${info[0][4]}`
  }

  const session = bot.session({
    type: 'message',
    channel: {
      id: `live:${bot.config.roomId}`,
      type: Session.Channel.Type.TEXT,
    },
    user: { id: uid, name: uname },
    message: {
      id: msgId,
      content: text,
      elements: [h.text(text)],
    },
    timestamp: info[0][4],  // 已经是 ms
  })

  bot.dispatch(session)

  // 自定义事件
  bot.dispatch(bot.session({
    type: 'bililive/danmaku',
    userId: uid,
    userName: uname,
    content: text,
    guardLevel: info[7] || 0,
    medalName: info[3]?.[1] || '',
    medalLevel: info[3]?.[0] || 0,
    timestamp: info[0][4],
  } as any))
}
```

### 9.2 SEND_GIFT → Session (type: bililive-gift)

```typescript
// msg.data 结构：
// data.uid, data.uname, data.face
// data.giftId, data.giftName, data.num, data.price (金瓜子单价)
// data.coin_type ("gold"=付费, "silver"=免费)
// data.batch_combo_id (连击 ID)
// data.combo_num, data.super_batch_gift_num
// data.tid (事务 ID，用于合并)

function handleSendGift(msg: any, bot: BiliLiveBot) {
  if (!bot.config.enableGift) return
  const data = msg.data

  // 礼物合并逻辑（与 open 模式类似）
  const key = data.batch_combo_id || `${data.uid}_${data.giftId}_${Date.now()}`
  // ... 同样的 pendingGifts 合并逻辑 ...
}
```

### 9.3 SUPER_CHAT_MESSAGE → Session (type: bililive-superchat)

```typescript
// msg.data 结构：
// data.uid, data.user_info.uname, data.user_info.face
// data.message (SC 文本)
// data.price (金额，人民币)
// data.time (持续时间，秒)
// data.id (SC ID)
// data.start_time, data.end_time

function handleSuperChat(msg: any, bot: BiliLiveBot) {
  const data = msg.data
  const session = bot.session({
    type: 'bililive-superchat' as any,
    channel: {
      id: `live:${bot.config.roomId}`,
      type: Session.Channel.Type.TEXT,
    },
    user: {
      id: String(data.uid),
      name: data.user_info.uname,
      avatar: data.user_info.face,
    },
    message: {
      id: `sc_${data.id}`,
      content: data.message,
      elements: [h('bililive:superchat', {
        price: data.price,
        duration: data.time,
        message: data.message,
      })],
    },
    timestamp: data.start_time * 1000,
  })
  bot.dispatch(session)
}
```

### 9.4 GUARD_BUY → Session (type: bililive-guard)

```typescript
// msg.data 结构：
// data.uid, data.username
// data.guard_level (1=总督, 2=提督, 3=舰长)
// data.num (月数)
// data.price (金瓜子)
// data.start_time

function handleGuardBuy(msg: any, bot: BiliLiveBot) {
  const data = msg.data
  const guardName = GUARD_NAMES[data.guard_level]
  const session = bot.session({
    type: 'bililive-guard' as any,
    channel: {
      id: `live:${bot.config.roomId}`,
      type: Session.Channel.Type.TEXT,
    },
    user: {
      id: String(data.uid),
      name: data.username,
    },
    message: {
      id: `guard_${data.uid}_${data.start_time}`,
      content: `[上舰] ${data.username} 开通 ${guardName} x${data.num}`,
      elements: [h('bililive:guard', {
        guardLevel: data.guard_level,
        guardName,
        guardNum: data.num,
      })],
    },
    timestamp: data.start_time * 1000,
  })
  bot.dispatch(session)
}
```

### 9.5 INTERACT_WORD → 入场/关注

```typescript
// msg.data 结构：
// data.uid, data.uname
// data.msg_type: 1=进入, 2=关注
// data.timestamp (秒)

function handleInteractWord(msg: any, bot: BiliLiveBot) {
  const data = msg.data
  if (data.msg_type === 1 && bot.config.enableEntry) {
    bot.dispatch(bot.session({
      type: 'bililive/enter',
      userId: String(data.uid),
      userName: data.uname,
      roomId: bot.config.roomId,
      timestamp: data.timestamp * 1000,
    } as any))
  } else if (data.msg_type === 2) {
    bot.dispatch(bot.session({
      type: 'bililive/follow',
      userId: String(data.uid),
      userName: data.uname,
      roomId: bot.config.roomId,
      timestamp: data.timestamp * 1000,
    } as any))
  }
}
```

### 9.6 其他 Web 模式事件

| CMD | 含义 | 处理 |
|-----|------|------|
| LIVE | 开播 | emit `bililive/live-start` |
| PREPARING | 下播 | emit `bililive/live-end` |
| WARNING | 超管警告 | emit `bililive/warning` |
| CUT_OFF | 被切断 | emit `bililive/cut-off` |
| WATCHED_CHANGE | 看过人数变化 | emit `bililive/watched-change` (data.num) |
| ROOM_REAL_TIME_MESSAGE_UPDATE | 粉丝数变化 | 可忽略 |

```typescript
private handleWebCommand(msg: { cmd: string; data?: any; info?: any }) {
  if (msg.cmd.startsWith('DANMU_MSG')) {
    this.handleDanmuMsg(msg)
    return
  }

  switch (msg.cmd) {
    case 'SEND_GIFT':
      this.handleSendGift(msg)
      break
    case 'SUPER_CHAT_MESSAGE':
      this.handleSuperChat(msg)
      break
    case 'GUARD_BUY':
      this.handleGuardBuy(msg)
      break
    case 'INTERACT_WORD':
      this.handleInteractWord(msg)
      break
    case 'LIVE':
      bot.dispatch(bot.session({ type: 'bililive/live-start' } as any))
      break
    case 'PREPARING':
      bot.dispatch(bot.session({ type: 'bililive/live-end' } as any))
      break
    case 'WARNING':
      bot.dispatch(bot.session({
        type: 'bililive/warning',
        msg: msg.data?.msg || msg.msg,
        roomId: bot.config.roomId,
      } as any))
      break
    case 'WATCHED_CHANGE':
      bot.dispatch(bot.session({
        type: 'bililive/watched-change',
        num: msg.data?.num || 0,
      } as any))
      break
    default:
      this.logger.debug('Unhandled web cmd:', msg.cmd)
  }
}
```

---

## 十、HTTP API (http-api.ts)

### 10.1 开放平台 API (open/http-api.ts)

所有开放平台 API 的 base URL 为 `https://live-open.biliapi.com`。

| 接口 | 方法 | 路径 | Body | 说明 |
|------|------|------|------|------|
| 开始会话 | POST | /v2/app/start | `{code, app_id}` | 获取 auth_body + wss_link |
| 平台心跳 | POST | /v2/app/heartbeat | `{game_id}` | 每 20s 必须调用 |
| 结束会话 | POST | /v2/app/end | `{game_id, app_id}` | 主动结束时调用 |
| 批量心跳 | POST | /v2/app/batchHeartbeat | `{game_ids:[]}` | 多房间心跳 (可选) |

```typescript
import { getOpenPlatformHeaders } from './auth'

export class OpenHttpApi {
  constructor(
    private ctx: Context,
    private accessKey: string,
    private accessSecret: string,
  ) {}

  private baseUrl = 'https://live-open.biliapi.com'

  private async request<T>(path: string, body: object): Promise<T> {
    const headers = getOpenPlatformHeaders(body, this.accessKey, this.accessSecret)
    const resp = await this.ctx.http.post(this.baseUrl + path, body, { headers })
    if (resp.code !== 0) {
      throw new Error(`Open API error [${resp.code}]: ${resp.message}`)
    }
    return resp.data
  }

  async appStart(code: string, appId: number) {
    return this.request<AppStartResponse['data']>('/v2/app/start', { code, app_id: appId })
  }

  async appHeartbeat(gameId: string) {
    return this.request('/v2/app/heartbeat', { game_id: gameId })
  }

  async appEnd(gameId: string, appId: number) {
    return this.request('/v2/app/end', { game_id: gameId, app_id: appId })
  }
}
```

### 10.2 Web API (web/http-api.ts)

混合模式和 Web 模式的写操作使用传统 B站 API + Cookie 认证。混合模式仅复用 `WebHttpApi`，不创建 Web 长连接。

```typescript
import { getWebHeaders } from './auth'

export class WebHttpApi {
  constructor(
    private ctx: Context,
    private credential: WebModeConfig["credential"],
    private roomId: number,
  ) {}

  /** 发送弹幕 */
  async sendDanmaku(msg: string, color = 16777215, fontsize = 25, mode = 1) {
    const data = new URLSearchParams({
      msg,
      roomid: String(this.roomId),
      color: String(color),
      fontsize: String(fontsize),
      mode: String(mode),
      rnd: String(Math.floor(Date.now() / 1000)),
      csrf: this.credential.biliJct,
      csrf_token: this.credential.biliJct,
    })

    const resp = await this.ctx.http.post(
      'https://api.live.bilibili.com/msg/send',
      data.toString(),
      {
        headers: {
          ...getWebHeaders(this.credential),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    )

    if (resp.code !== 0) throw new Error(`Send danmaku failed: ${resp.message}`)
    return resp
  }

  /** 封禁用户 */
  async blockUser(uid: number, hour = 1) {
    return this.ctx.http.post(
      'https://api.live.bilibili.com/banned_service/v2/Silent/add_block_list',
      new URLSearchParams({
        roomid: String(this.roomId),
        block_uid: String(uid),
        hour: String(hour),
        csrf: this.credential.biliJct,
        csrf_token: this.credential.biliJct,
      }).toString(),
      { headers: { ...getWebHeaders(this.credential), "Content-Type": "application/x-www-form-urlencoded" } }
    )
  }

  /** 解封用户 */
  async unblockUser(blockId: number) {
    return this.ctx.http.post(
      'https://api.live.bilibili.com/banned_service/v2/Silent/del_block_list',
      new URLSearchParams({
        roomid: String(this.roomId),
        id: String(blockId),
        csrf: this.credential.biliJct,
        csrf_token: this.credential.biliJct,
      }).toString(),
      { headers: { ...getWebHeaders(this.credential), "Content-Type": "application/x-www-form-urlencoded" } }
    )
  }
}
```

---

## 十一、Bot 类 (bot.ts)

```typescript
import { Bot, Context, Session, h } from 'koishi'
import { BiliLiveConfig } from './config'
import { OpenWSClient } from './open/ws-client'
import { WebWSClient } from './web/ws-client'
import { OpenHttpApi } from './open/http-api'
import { WebHttpApi } from './web/http-api'

export class BiliLiveBot extends Bot<BiliLiveConfig> {
  static platform = 'bililive'
  private wsClient: OpenWSClient | WebWSClient
  private httpApi: OpenHttpApi | WebHttpApi

  constructor(ctx: Context, config: BiliLiveConfig) {
    super(ctx, config)
    this.selfId = `bililive:${config.roomId}`
    this.platform = 'bililive'

    if (config.mode === 'open') {
      this.wsClient = new OpenWSClient(ctx, config, this)
      this.httpApi = new OpenHttpApi(ctx, config.accessKey, config.accessSecret)
    } else {
      this.wsClient = new WebWSClient(ctx, config, this)
      this.httpApi = new WebHttpApi(ctx, config.credential, config.roomId)
    }
  }

  async start() {
    await this.wsClient.connect()
    this.status = 'online'
    this.logger.info(`BiliLive bot started (mode: ${this.config.mode}, room: ${this.config.roomId})`)
  }

  async stop() {
    await this.wsClient.stop()
    this.status = 'offline'
  }

  async sendMessage(channelId: string, content: string) {
    // 使用 MessageEncoder 处理
    const encoder = new BiliLiveMessageEncoder(this, channelId)
    await encoder.send(content)
  }

  async getSelf() {
    return {
      userId: `bililive:${this.config.uid}`,
      username: '主播',  // 可从 API 获取实际昵称
      avatar: '',
    }
  }

  async getChannel(channelId: string) {
    return {
      channelId,
      channelName: `直播间 ${this.config.roomId}`,
    }
  }
}
```

---

## 十二、MessageEncoder (message.ts)

弹幕只支持纯文本，需要：
1. 将消息元素转换为纯文本
2. 按 `maxDanmakuLength` 分段
3. 按 `sendInterval` 限速发送

```typescript
import { MessageEncoder, h } from 'koishi'

export class BiliLiveMessageEncoder extends MessageEncoder<BiliLiveBot> {
  private buffer = ""

  async flush() {
    if (!this.buffer) return

    // 分段
    const chunks = this.splitText(this.buffer, this.bot.config.maxDanmakuLength)

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await this.sleep(this.bot.config.sendInterval)
      }

      await this.bot.sendDanmaku(chunks[i])
    }

    this.buffer = ''
  }

  async visit(element: h) {
    if (element.type === 'text') {
      this.buffer += element.attrs.content
    } else if (element.type === 'at') {
      this.buffer += `@${element.attrs.name || element.attrs.id} `
    } else if (element.type === 'image') {
      this.bot.logger.warn('BiliLive does not support sending images')
    } else if (element.type === 'br') {
      // 弹幕不支持换行，用空格代替
      this.buffer += ' '
    } else {
      // 递归处理子元素
      for (const child of element.children || []) {
        await this.visit(child)
      }
    }
  }

  private splitText(text: string, maxLen: number): string[] {
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen))
    }
    return chunks
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
```

---

## 十三、Adapter 类 (adapter.ts)

```typescript
import { Adapter, Context } from 'koishi'
import { BiliLiveBot } from './bot'
import { BiliLiveConfig } from './config'

export class BiliLiveAdapter extends Adapter<BiliLiveBot> {
  static reusable = true

  async connect(bot: BiliLiveBot) {
    await bot.start()
  }

  async disconnect(bot: BiliLiveBot) {
    await bot.stop()
  }
}
```

---

## 十四、插件入口 (index.ts)

```typescript
import { Context } from 'koishi'
import { BiliLiveBot } from './bot'
import { BiliLiveAdapter } from './adapter'
import { BiliLiveConfig, Config } from './config'

export const name = 'adapter-bililive'
export const inject = ['http']
export { Config }

// 声明 Koishi 事件类型扩展
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
    'bililive/watched-change'(session: Session): void
    'bililive/code-expired'(session: Session): void
  }
}

export function apply(ctx: Context, config: BiliLiveConfig) {
  ctx.plugin(BiliLiveAdapter, {
    platform: 'bililive',
    bot: BiliLiveBot,
    config,
  })
}
```

---

## 十五、类型定义 (types.ts)

```typescript
// ==================== WebSocket 协议相关 ====================

export enum WSOperation {
  HEARTBEAT = 2,
  HEARTBEAT_REPLY = 3,
  MESSAGE = 5,
  AUTH = 7,
  AUTH_REPLY = 8,
}

export interface WSPacket {
  operation: WSOperation
  body: Buffer
}

// ==================== 开放平台 API 响应 ====================

export interface AppStartResponse {
  code: number
  message: string
  data: {
    anchor_info: {
      room_id: number
      uid: number
      uname: string
      uface: string
    }
    game_info: {
      game_id: string
    }
    websocket_info: {
      auth_body: string
      wss_link: string[]
    }
  }
}

// ==================== Web 模式 API 响应 ====================

export interface DanmuInfoResponse {
  code: number
  data: {
    token: string
    host_list: Array<{
      host: string
      port: number
      wss_port: number
      ws_port: number
    }>
  }
}

// ==================== 事件数据接口 ====================

/** 开放平台弹幕数据 */
export interface OpenDMData {
  msg: string
  uid: number
  uname: string
  uface: string
  guard_level: number
  timestamp: number
  msg_id: string
  room_id: number
  open_id: string
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
}

/** 开放平台礼物数据 */
export interface OpenGiftData {
  uid: number
  uname: string
  uface: string
  gift_id: number
  gift_name: string
  gift_num: number
  price: number
  paid: boolean
  guard_level: number
  timestamp: number
  msg_id: string
  room_id: number
  open_id: string
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
  combo_id: string
  combo_num: number
}

/** 开放平台 SC 数据 */
export interface OpenSuperChatData {
  uid: number
  uname: string
  uface: string
  message: string
  rmb: number
  start_time: number
  end_time: number
  msg_id: string
  room_id: number
  open_id: string
  guard_level: number
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
}

/** 开放平台上舰数据 */
export interface OpenGuardData {
  user_info: {
    uid: number
    uname: string
    uface: string
  }
  guard_level: number
  guard_num: number
  fans_medal_wearing_status: boolean
  fans_medal_name: string
  fans_medal_level: number
  room_id: number
  msg_id: string
  timestamp: number
}

/** 互动事件数据（点赞/入场） */
export interface OpenInteractData {
  uid: number
  uname: string
  uface: string
  timestamp: number
  room_id: number
}

/** 警告数据 */
export interface WarningData {
  msg: string
  room_id: number
}

// ==================== 通用常量 ====================

export const GUARD_NAMES: Record<number, string> = {
  1: '总督',
  2: '提督',
  3: '舰长',
}

export const OPEN_API_BASE = "https://live-open.biliapi.com"
```

---

## 十六、package.json

```json
{
  "name": "koishi-plugin-adapter-bililive",
  "version": "0.2.0",
  "description": "Koishi adapter for Bilibili Live (Open Platform + Web mode)",
  "main": "lib/index.js",
  "typings": "lib/index.d.ts",
  "files": ["lib", "dist"],
  "license": "MIT",
  "keywords": ["koishi", "plugin", "adapter", "bilibili", "live", "danmaku"],
  "koishi": {
    "description": {
      "zh": "B站直播适配器（支持开放平台和 Cookie 模式）"
    },
    "service": {
      "required": ["http"]
    }
  },
  "peerDependencies": {
    "koishi": "^4.18.7"
  },
  "devDependencies": {
    "koishi": "^4.18.7",
    "typescript": "^5.0.0"
  }
}
```

---

## 十七、实现注意事项

### 关键陷阱与易错点

1. **Open 平台 auth_body 是 JSON 字符串**：从 /v2/app/start 拿到后直接用，不要 JSON.parse 再 stringify。直接 `Buffer.from(authBody, "utf-8")` 作为 WS auth/heartbeat 包的 body。

2. **Open 平台 HTTP 心跳每 20s 是强制要求**：如果超过 ~60s 没有收到 HTTP heartbeat，B站服务器会主动断开 WS 连接。即使 WS 心跳正常也不行。

3. **INTERACTION_END ≠ 简单 WS 重连**：收到此事件表示整个 session 已结束（game_id 作废），必须重新调用 /v2/app/start 获取新的 auth_body 和 game_id。

4. **主播身份码 (code) 有有效期**：如果 /v2/app/start 返回特定错误码（如 7003），说明 code 已过期，应该 emit `bililive/code-expired` 事件通知用户，并停止重试。

5. **guard_level 映射**：1=总督（最高）, 2=提督, 3=舰长（最低）。注意不是 1=舰长。

6. **Web 模式 DANMU_MSG 命令名可能有后缀**：如 `DANMU_MSG:4:0:2:2:2:0`，务必使用 `cmd.startsWith("DANMU_MSG")` 而非严格相等。

7. **Web 模式 UID 需要 String() 转换**：`info[2][0]` 是 number 类型，但 B站 UID 可能超过 JavaScript 安全整数范围 (2^53)，建议统一转为字符串处理。

8. **时间戳单位不统一**：
   - Open 平台：data.timestamp 统一为秒
   - Web 模式 DANMU_MSG：info[0][4] 为毫秒
   - Web 模式 INTERACT_WORD：data.timestamp 为秒
   - 构造 Session 时统一转为 ms

9. **礼物连击合并**：
   - 使用 combo_id（open）或 batch_combo_id（web）作为 key
   - 设置 giftComboDuration 超时后才 emit 最终事件
   - 每次收到同 key 的新消息时重置超时
   - combo_num 表示累计连击数（直接使用，不要自己累加 gift_num）

10. **弹幕发送限制**：
    - maxDanmakuLength：B站限制通常为 20 字（普通用户）或 30 字（月费/年费老爷）
    - sendInterval：发送过快会被 B站 静默丢弃，建议 >= 1000ms
    - 需要分段 + 限速发送

11. **wss_link 数组降级**：/v2/app/start 返回的 wss_link 是一个数组（通常 2-3 个地址），按优先级排序。第一个连接失败时应尝试下一个。

---

## 十八、推荐开发顺序

按依赖关系排序，建议按以下顺序实现：

| 阶段 | 文件 | 说明 |
|------|------|------|
| 1 | types.ts + config.ts | 基础类型和配置定义，无外部依赖 |
| 2 | open/auth.ts | 签名算法，纯函数，可独立测试 |
| 3 | utils.ts | 二进制包编解码，纯函数，可独立测试 |
| 4 | open/ws-client.ts | 核心：/v2/app/start + WS 连接 + 双心跳 |
| 5 | open/events.ts | LIVE_OPEN_PLATFORM_* → Session 映射 |
| 6 | bot.ts | 组装 Bot 类，先只支持 open 模式 |
| 7 | message.ts | MessageEncoder，弹幕分段 + 限速 |
| 8 | adapter.ts + index.ts | Adapter 壳 + 插件入口 |
| 9 | web/auth.ts + web/ws-client.ts + web/events.ts | Web 模式全部实现 |
| 10 | open/http-api.ts + web/http-api.ts | 写操作 API |

**里程碑检查点：**
- 阶段 4 完成后：应能在控制台看到 WS 连接成功 + 收到原始消息日志
- 阶段 6 完成后：应能在 Koishi 控制台看到弹幕消息 Session
- 阶段 8 完成后：应能作为 Koishi 插件正常加载，接收弹幕
- 阶段 9 完成后：两种模式均可工作

---

## 十九、参考资源

### 项目内部参考文件

| 文件路径 | 内容 | 用途 |
|----------|------|------|
| `js-demo/server/tool/index.ts` | 开放平台签名算法 (TypeScript) | 直接参考实现 open/auth.ts |
| `js-demo/client/src/socket/index.ts` | WS 连接 + auth_body 使用方式 | 参考 open/ws-client.ts |
| `bililive_dm/BiliDMLib/OpenDanmakuLoader.cs` | TCP 长连接完整实现 (C#) | 理解协议细节 |
| `bililive_dm/BilibiliDM_PluginFramework/DanmakuModel.cs:465-542` | LIVE_OPEN_PLATFORM_* 事件解析 | 确认事件字段 |
| `bililive_dm/Bililive_dm/BOpen.cs` | /v2/app/start + /v2/app/heartbeat 调用 | 确认 API 用法 |
| `external/adapter-bilibili-dm/src/` | Koishi adapter 模式参考 | 架构模式参考 |

### 外部参考

| 资源 | 说明 |
|------|------|
| B站直播开放平台文档 (PDF) | 官方 API 文档（图片版，仅作视觉参考） |
| https://open-live.bilibili.com/ | 开放平台开发者注册入口 |
| Koishi 文档 - Adapter 开发 | https://koishi.chat/guide/adapter/ |
| Koishi 文档 - Bot API | https://koishi.chat/api/core/bot.html |

### 关键设计决策记录

1. **为什么用 Schema.union 而非两个独立插件？** 因为两种模式的事件输出格式完全一致（统一为 Session），用户切换模式时只需改配置，不需要改下游逻辑。

2. **为什么不用 ws 库直接连接？** Koishi 提供了 ctx.http.ws() 方法，自动处理 dispose 生命周期，避免内存泄漏。

3. **为什么礼物合并在 adapter 层做？** 因为 B站发送礼物时会分多个 WS 消息（每按一次发一个），如果直接转发给 Koishi，下游会收到大量重复事件。合并后只 emit 一次最终结果。

4. **为什么自定义事件类型 (bililive/*) 而非只用 message？** 因为礼物、SC、上舰等不是传统意义的"消息"，需要携带金额、等级等元数据。同时保留 message type 给弹幕，确保与 Koishi 命令系统兼容。

---

*文档版本: v2.0 | 最后更新: 2025-01*
