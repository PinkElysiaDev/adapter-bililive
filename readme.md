# koishi-plugin-adapter-bililive

将 B 站直播间弹幕、礼物、醒目留言、上舰和互动事件转换为 Koishi Session。

支持三种模式：

- `open`：B 站直播开放平台，使用 `appId`、`accessKey`、`accessSecret` 和主播身份码。
- `hybrid`：开放平台长连接负责接收事件，登录 Cookie 仅调用 Web API 发送弹幕；推荐需要指令回复时使用。
- `web`：传统 Cookie Web 协议，使用 `SESSDATA`、`bili_jct`、`DedeUserID` 和 `buvid3`。

弹幕会作为标准 `message` Session 分发，可以触发 Koishi 中间件和指令；其他直播事件通过 `bililive/*` Session 事件分发。

混合模式和 Web 模式支持通过 `bot.sendMessage('live:<roomId>', content)` 发送直播弹幕。开放平台模式当前仅接收事件。

混合模式启动时会验证 Cookie 登录态及 `DedeUserID`，但不会通过 Cookie 建立接收长连接。Cookie 属于敏感凭据，可能过期或触发平台风控，请使用专门的发送账号并妥善保管。
