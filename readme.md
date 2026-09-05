# koishi-plugin-adapter-bililive

将 B 站直播间弹幕、礼物、醒目留言、上舰和互动事件转换为 Koishi Session。

支持三种模式：

- `open`：B 站直播开放平台，使用 `appId`、`accessKey`、`accessSecret` 和主播身份码。
- `hybrid`：开放平台长连接负责接收事件，登录 Cookie 仅调用 Web API 发送弹幕；推荐需要指令回复时使用。
- `web`：传统 Cookie Web 协议，使用 `SESSDATA`、`bili_jct`、`DedeUserID` 和 `buvid3`。

弹幕会作为标准 `message` Session 分发，可以触发 Koishi 中间件和指令；其他直播事件通过 `bililive/*` Session 事件分发。适配器**无条件派发**所有收到的直播事件（礼物、醒目留言、上舰、入场、点赞、关注、开关播等），不做按事件类型的接收开关——是否处理某类事件由消费方插件自行过滤。`giftComboDuration` 是事件整形参数（连击合并窗口），不是过滤器。

机器人身份说明：bot 的 `platform` 为 `bililive`，`selfId` **恒为配置的主播 UID**（即 `bililive:<uid>`），不会因连接模式或开播状态变化。开放平台分配给主播的 `open_id` 仅作为适配器内部的自消息识别映射（`bot.anchorOpenId`），同一 appId + 主播下稳定，更换 appId 时会变化（仅影响内部识别，不影响 bot 身份）。注意：旧版本曾把 open_id 写入 selfId 导致运行时身份漂移——如果你有插件（如 multi-bot-controller）按当时的 open_id 配置过 `selfId`，请改回主播 UID；数据统计面板中按 open_id 分桶的历史记录不会自动合并。

混合模式和 Web 模式支持通过 `bot.sendMessage('live:<roomId>', content)` 发送直播弹幕。开放平台模式当前仅接收事件。每条弹幕发送成功后会派发标准 `send` 事件，因此能被控制台「数据统计」「概况」等面板正常计数。

配置项 `reportSelf`（默认关闭）控制是否上报机器人自己的消息：默认关闭时过滤 bot 自己发出的弹幕回声（防止自我循环）；开启后自身弹幕会作为普通 `message` 事件分发给下游插件（会计入「接收消息」，且混合模式下发送账号与主播不同，机器人可能响应自己，请谨慎开启）。若你此前显式配置过旧版的 `ignoreSelf: false`，请删除该键并改开 `reportSelf`。

混合模式启动时会验证 Cookie 登录态及 `DedeUserID`，但不会通过 Cookie 建立接收长连接。Cookie 属于敏感凭据，可能过期或触发平台风控，请使用专门的发送账号并妥善保管。
