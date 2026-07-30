# B 站直播间认证机制对比分析

> 本文对比 （我们的 Koishi 插件）与  弹幕姬 /  点歌机在连接 B 站直播间时的认证差异，
> 解释为什么点歌机/弹幕姬不需要 cookie，而我们的 adapter 需要 cookie。
> 作为  认证选型的决策补充，供 GPT-5.6sol 实现时参考。

---

## 一、问题背景

 弹幕姬和  点歌机连接 B 站直播间接收弹幕时，只需要一个房间号，不需要任何登录凭证。
而我们的  设计文档（IMPLEMENTATION_DESIGN.md 第三章）却把 cookie（SESSDATA + bili_jct + DedeUserID）设为必填。
这一差异的根源不在于实现技巧，而在于**插件角色与操作类型**的不同。

---

## 二、核心结论

B 站直播间的弹幕**接收**与**发送/管理**是两套权限要求完全不同的操作：

- **接收弹幕**：B 站允许以**匿名游客身份（uid=0）**连接直播间弹幕 WebSocket/TCP，纯匿名接收弹幕流。无需 cookie、无需 WBI 签名。
- **发送弹幕 / 管理房间**：禁言、设房管、以主播身份发言等**写操作**必须携带登录态（SESSDATA cookie + bili_jct 作为 csrf）。

点歌机/弹幕姬只做"监听"，所以匿名即可；我们的 adapter 定位为**主播本人**，要发弹幕、管房间，属于写操作，故需 cookie。

---

## 三、证据一：弹幕姬的匿名连接

 是弹幕姬连接 B 站直播间的核心。

### 3.1 获取弹幕服务器配置——纯匿名 HTTP GET

```csharp
// DanmakuTcpConnection.cs:20
CIDInfoUrl = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=";

// :22-30  ConnectAsync(roomId)
var info = await httpClient.GetFromJsonAsync<DanmuInfo>(CIDInfoUrl + roomId);
var token = info.data.token;
```

注意：请求 URL 只有 ，**没有 cookie、没有 WBI 签名**。
对比我们的设计文档（IMPLEMENTATION_DESIGN.md 第五章 5.2）：adapter 的 getDanmuInfo 调用要  并附  头。
弹幕姬证明：getDanmuInfo 本身可匿名调用，WBI 签名/cookie 只在我们需要更高频次/登录态时才必要。

### 3.2 认证包——uid=0 匿名游客

```csharp
// DanmakuTcpConnection.cs:331-340  SendJoinChannel
var packetModel = new
    { roomid = channelId, uid = 0, protover = 3, key = token, platform = "danmuji", type = 2 };
var playload = JsonConvert.SerializeObject(packetModel);
await SendSocketDataAsync(7, playload, ct);   // 7 = OpAuth
```

关键： 表示匿名游客身份。B 站允许以游客身份接入直播间弹幕流。
对比我们的设计文档（5.2 onOpen）：认证包里 （主播真实 UID）。这是角色差异的直接体现——
弹幕姬不想代表任何人，uid 填 0；我们的 adapter 要代表主播，uid 填主播真实 UID，并且配合 cookie 才能获得与主播身份绑定的权限。

### 3.3 弹幕姬的登录是做什么的

弹幕姬作为桌面应用，确实有登录/发送弹幕功能，但那是**可选的发送端能力**，与接收弹幕完全解耦。
即：不登录也能收弹幕（匿名 uid=0）；登录只是为了以自己身份发弹幕。
这正好印证了"接收=匿名，发送=登录"的权限分离。

---

## 四、证据二：AynaLivePlayer 的双 Provider 与第三条路

（点歌机）用  抽象了两种连接 B 站的方式，揭示出 cookie 之外还有"开放平台身份码"这条第三路。

### 4.1 注册两种 provider

```go
// AynaLivePlayer/internal/liveroom/liveroom.go:29-31
liveroomsdk.RegisterProvider(openblive.NewOpenBLiveClientProvider(cfg.ApiServer, 1661006726438))
// ignore web danmu client
liveroomsdk.RegisterProvider(webdm.NewWebDanmuClientProvider(cfg.ApiServer))
```

- （OpenBLIV）：B 站**开放平台**连接。第二个参数  是开放平台项目 code（身份码）。
- ：网页弹幕协议（与弹幕姬同源，匿名 uid=0 那一套）。
两者都经  中转（默认 ，见 ），协议细节封装在  子模块内。

### 4.2 身份码 vs 网页协议——历史备注

 留下了关键线索：

```text
# todo.txt:38
2024.08.06 : 修复使用身份码连接的时候房管无法切歌的问题

# todo.txt:55
2024.04.17 : 1. 弹幕拿不到的问题，尽量使用身份码，网页协议随时可能爆炸
```

这明确区分了"身份码连接"（开放平台）与"网页协议"（匿名 web 弹幕），并警告后者"随时可能爆炸"——
即 B 站可能随时收紧匿名 web 弹幕协议。点歌机推荐用身份码以求稳定。

### 4.3 点歌机如何消费弹幕

```go
// plugin/diange/diange.go:134-137
global.EventBus.Subscribe("", events.LiveRoomMessageReceive, "plugin.diange.message", d.handleMessage)

// :239-240  handleMessage
message := event.Data.(events.LiveRoomMessageReceiveEvent).Message
msgs := strings.Split(message.Message, " ")
```

点歌机只是订阅  事件，从  取弹幕文本做点歌解析。
它完全不关心登录态——它只听，从不说。

---

## 五、B 站三种认证方式对比

| 方式 | 代表身份 | 获取难度 | 权限范围 | 稳定性 | 适用场景 |
|------|----------|----------|----------|--------|----------|
| **匿名 web 弹幕**（uid=0） | 游客 | 极低（仅房间号） | 只读接收弹幕 | 低（B 站可能收紧） | 弹幕姬/点歌机监听 |
| **Cookie 登录态** | 登录用户 | 低（浏览器 F12 复制） | 接收 + 发弹幕 + 管房间（以该用户身份） | 中（cookie 会过期） | 主播本人 bot、个人助手 |
| **开放平台身份码**（access_key/code） | 开放平台项目 | 高（需项目审核） | 接收 + 项目授权互动 | 高（官方支持） | 商业第三方应用、长期稳定服务 |

---

## 六、为什么 adapter 选 cookie

我们的  设计文档选择 cookie，原因：

1. **角色决定**：adapter 定位为**主播本人**（见 IMPLEMENTATION_DESIGN.md 第一章 1.2 设计原则），需要以主播身份发弹幕、禁言、管房管——全是写操作，匿名 uid=0 做不到。
2. **cookie 最易获取**：主播在自己浏览器登录 B 站后，F12 复制 SESSDATA/bili_jct/DedeUserID 即可，无需任何审核。开放平台身份码需要实名项目审核，门槛过高。
3. **与 adapter-bilibili-dm 一脉相承**：参考插件已实现完整的 cookie 注入 + WBI 签名链路（见其 ），可直接复用模式。

因此 IMPLEMENTATION_DESIGN.md 第三章把 credential 设为必填、第四章 auth.ts 实现 cookie 注入与 WBI 签名，是合理且与角色定位一致的选择。

---

## 七、对设计文档的审视与建议

基于上述对比，给 GPT-5.6sol 的潜在优化点（**可选**，非必须）：

### 7.1 支持"仅监听模式"作为降级

当前设计把  整体设为 。若用户只想把直播间事件接入 Koishi 做展示/记录，不需要 bot 发弹幕，
理论上可匿名（uid=0、无 cookie）连接 WebSocket 接收弹幕——证据见弹幕姬 。

建议：将  中关键字段（sessdata/biliJct/dedeUserId）改为**可选**。在  /  中：
- 若 cookie 存在：走登录态连接（uid=主播UID，带 WBI 签名）， 等写操作可用；
- 若 cookie 为空：走匿名连接（uid=0，认证包 ，getDanmuInfo 不带 cookie/不签名），仅接收事件， 抛"未配置 cookie"错误。

这能覆盖"只想看不想发"的轻量场景，扩大适用面。但注意：匿名连接能收到的事件类型可能与登录态有差异（例如部分需登录的房间/舰长信息），
且匿名协议稳定性低（见第八章风险）。若 GPT-5.6sol 判断复杂度不划算，**保持 cookie 必填、不支持匿名**也是完全可接受的简单方案。

### 7.2 认证包 uid 的灵活性

即便配置了 cookie，WS 认证包里的  字段也可考虑两种取值：
- （主播真实 UID）：与登录态绑定，能收到与本人相关的事件；
- （匿名）：即使有 cookie 也以游客身份接入弹幕流，减少风险。
参考弹幕姬始终用 uid=0。建议默认用真实 uid（与设计文档一致），但可保留 uid=0 作为可选项。

---

## 八、风险提示

1. **匿名 web 弹幕协议不稳定**：AynaLivePlayer  明确警告"网页协议随时可能爆炸"。若 7.1 采用匿名监听模式，需告知用户这是尽力而为、非长期稳定方案。
2. **cookie 会过期**：SESSDATA 有有效期，过期后需重新复制。设计文档第四章 auth.ts 的 WBI keys 已做 TTL 缓存，但 cookie 本身的过期需用户手动更新。
3. **长期稳定优先开放平台**：若项目目标是长期稳定的商业服务，应考虑迁移到 B 站开放平台身份码（参考 AynaLivePlayer  provider），
   但需项目审核、申请 access_key/secret，超出当前 cookie 方案范围。

---

## 九、关键文件引用汇总

| 文件 | 行号 | 内容 |
|------|------|------|
|  | 20, 27 | 匿名 getDanmuInfo（无 cookie/无 WBI）|
| 同上 | 331-340 | 认证包 uid=0 匿名游客 |
|  | 29-31 | 注册 openbliv（身份码）+ webdm（网页协议）|
|  | 90-97 | OnMessage 接收弹幕 |
|  | 30 | ApiServer 默认 http://localhost:9090 中转 |
|  | 134-137, 239-240 | 点歌机订阅并解析弹幕 |
|  | 38, 55 | 身份码 vs 网页协议备注 |
|  | 第三章 | credential 必填配置 |
| 同上 | 第四章 | auth.ts cookie 注入 + WBI 签名 |
| 同上 | 第五章 5.2 | WS 认证包 uid=config.uid |

---

## 十、一句话总结

> 点歌机只需"听"，匿名能听；我们的 adapter 要"以主播身份说话和管理"，匿名听可以但说/管不行，故需 cookie。
> cookie 是浏览器登录态，比开放平台凭证更易获取，是个人主播 bot 的最佳折中。
