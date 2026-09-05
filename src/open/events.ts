import { h } from 'koishi'
import type { BiliLiveBot } from '../bot'
import type { OpenDMData, OpenGiftData, OpenGuardData, OpenInteractData, OpenSuperChatData, WarningData } from '../types'
import { GUARD_NAMES } from '../types'
import { roomScopes, toMilliseconds, trackGiftCombo } from '../utils'

function handleDanmaku(bot: BiliLiveBot, data: OpenDMData): void {
  const openId = data.open_id || String(data.uid)
  // 懒识别主播 open_id（B 站昵称全局唯一，uname 命中即主播本人）
  if (!bot.anchorOpenId && data.uname && bot.anchorName && data.uname === bot.anchorName && data.open_id) {
    bot.anchorOpenId = data.open_id
    bot.debug('懒识别主播 open_id：%s', data.open_id)
  }
  if (bot.isSelfMessage(openId, data.uname)) {
    bot.debug('跳过自身弹幕回声：uname=%s open_id=%s content=%j', data.uname, openId, data.msg)
    return
  }
  if (bot.isRecentlySent(data.msg)) {
    bot.debug('跳过发送去重命中的回声：content=%j', data.msg)
    return
  }
  bot.rememberMember(openId, data.uname, data.uface)
  const timestamp = toMilliseconds(data.timestamp)
  bot.dispatch(bot.session({
    type: 'message',
    timestamp,
    ...roomScopes(bot, data.room_id),
    user: { id: openId, name: data.uname, avatar: data.uface },
    message: { id: data.msg_id, content: data.msg, elements: [h.text(data.msg)], timestamp },
  }))
  bot.dispatchCustom('bililive/danmaku', data, timestamp)
}

function handleGift(bot: BiliLiveBot, data: OpenGiftData): void {
  const key = data.combo_id || `${data.uid}_${data.gift_id}_${data.timestamp}`
  // combo_num 缺失时按 gift_num 自行累加
  trackGiftCombo(bot, key, data, previous => data.combo_num || (previous ?? 0) + data.gift_num, (latest, totalNum) => {
    const timestamp = toMilliseconds(latest.timestamp)
    const openId = latest.open_id || String(latest.uid)
    bot.rememberMember(openId, latest.uname, latest.uface)
    bot.dispatch(bot.session({
      type: 'bililive-gift',
      timestamp,
      ...roomScopes(bot, latest.room_id),
      user: { id: openId, name: latest.uname, avatar: latest.uface },
      message: {
        id: latest.msg_id,
        content: `[礼物] ${latest.uname} 赠送 ${latest.gift_name} x${totalNum}`,
        elements: [h('bililive:gift', {
          giftId: latest.gift_id,
          giftName: latest.gift_name,
          giftNum: totalNum,
          price: latest.price,
          paid: latest.paid,
        })],
        timestamp,
      },
    }))
    bot.dispatchCustom('bililive/gift', { ...latest, gift_num: totalNum }, timestamp)
  })
}

function handleSuperChat(bot: BiliLiveBot, data: OpenSuperChatData): void {
  const timestamp = toMilliseconds(data.start_time)
  const openId = data.open_id || String(data.uid)
  bot.rememberMember(openId, data.uname, data.uface)
  bot.dispatch(bot.session({
    type: 'bililive-superchat',
    timestamp,
    ...roomScopes(bot, data.room_id),
    user: { id: openId, name: data.uname, avatar: data.uface },
    message: {
      id: data.msg_id,
      content: data.message,
      elements: [h('bililive:superchat', { price: data.rmb, message: data.message, endTime: data.end_time })],
      timestamp,
    },
  }))
  bot.dispatchCustom('bililive/superchat', data, timestamp)
}

function handleGuard(bot: BiliLiveBot, data: OpenGuardData): void {
  const timestamp = toMilliseconds(data.timestamp)
  const guardName = GUARD_NAMES[data.guard_level] || `等级${data.guard_level}`
  const openId = data.user_info.open_id || data.open_id || String(data.user_info.uid)
  bot.rememberMember(openId, data.user_info.uname, data.user_info.uface)
  bot.dispatch(bot.session({
    type: 'bililive-guard',
    timestamp,
    ...roomScopes(bot, data.room_id),
    user: { id: openId, name: data.user_info.uname, avatar: data.user_info.uface },
    message: {
      id: data.msg_id,
      content: `[上舰] ${data.user_info.uname} 开通 ${guardName} x${data.guard_num}`,
      elements: [h('bililive:guard', { guardLevel: data.guard_level, guardName, guardNum: data.guard_num })],
      timestamp,
    },
  }))
  bot.dispatchCustom('bililive/guard', { ...data, guard_name: guardName }, timestamp)
}

function handleLike(bot: BiliLiveBot, data: OpenInteractData): void {
  bot.dispatchCustom('bililive/like', data, toMilliseconds(data.timestamp))
}

function handleEnter(bot: BiliLiveBot, data: OpenInteractData): void {
  const openId = data.open_id || String(data.uid)
  const timestamp = toMilliseconds(data.timestamp)
  if (openId) {
    bot.rememberMember(openId, data.uname, data.uface)
    // 派发标准 guild-member-added 事件，让欢迎类插件触发
    bot.dispatch(bot.session({
      type: 'guild-member-added',
      timestamp,
      ...roomScopes(bot, data.room_id),
      user: { id: openId, name: data.uname, avatar: data.uface },
    }))
  }
  bot.dispatchCustom('bililive/enter', data, timestamp)
}

export function dispatchOpenEvent(bot: BiliLiveBot, command: string, data: any): void {
  switch (command) {
    case 'LIVE_OPEN_PLATFORM_DM': return handleDanmaku(bot, data)
    case 'LIVE_OPEN_PLATFORM_SEND_GIFT': return handleGift(bot, data)
    case 'LIVE_OPEN_PLATFORM_SUPER_CHAT': return handleSuperChat(bot, data)
    case 'LIVE_OPEN_PLATFORM_GUARD': return handleGuard(bot, data)
    case 'LIVE_OPEN_PLATFORM_LIKE': return handleLike(bot, data)
    case 'LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER': return handleEnter(bot, data)
    case 'OPEN_LIVEROOM_INTERACT_WORD':
      bot.dispatchCustom('bililive/follow', data, toMilliseconds(data.timestamp))
      return
    case 'OPEN_LIVEROOM_WARNING':
      bot.dispatchCustom('bililive/warning', data as WarningData)
      return
    case 'LIVE_OPEN_PLATFORM_LIVE_START':
      bot.dispatchCustom('bililive/live-start', data)
      return
    case 'LIVE_OPEN_PLATFORM_LIVE_END':
      bot.dispatchCustom('bililive/live-end', data)
      return
    default:
      bot.logger.debug('未处理的开放平台事件：%s', command)
  }
}
