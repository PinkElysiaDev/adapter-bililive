import { h } from 'koishi'
import type { BiliLiveBot } from '../bot'
import { GUARD_NAMES } from '../types'
import { roomScopes, toMilliseconds, trackGiftCombo } from '../utils'

function getDanmakuId(info: any[], uid: string): string {
  const fallback = `dm_${uid}_${info[0]?.[4] || Date.now()}`
  try {
    const source = info[0]?.[9]
    // extra 可能是 JSON 字符串、对象或缺省
    const extra = source && typeof source === 'object'
      ? (typeof source.extra === 'string' ? JSON.parse(source.extra) : source.extra)
      : JSON.parse(source || '{}')
    return String(extra?.msg_id || fallback)
  } catch {
    return fallback
  }
}

function handleDanmaku(bot: BiliLiveBot, message: any): void {
  const info = message.info
  if (!Array.isArray(info) || !Array.isArray(info[2])) return
  const text = String(info[1] ?? '')
  const uid = String(info[2][0] ?? '')
  const uname = String(info[2][1] ?? '')
  if (bot.isSelfMessage(uid, uname)) {
    bot.debug('跳过自身弹幕回声：uid=%s uname=%s content=%j', uid, uname, text)
    return
  }
  if (bot.isRecentlySent(text)) {
    bot.debug('跳过发送去重命中的回声：content=%j', text)
    return
  }
  bot.rememberMember(uid, uname, '')
  const timestamp = toMilliseconds(info[0]?.[4])
  bot.dispatch(bot.session({
    type: 'message',
    timestamp,
    ...roomScopes(bot),
    user: { id: uid, name: uname },
    message: { id: getDanmakuId(info, uid), content: text, elements: [h.text(text)], timestamp },
  }))
  bot.dispatchCustom('bililive/danmaku', {
    userId: uid,
    userName: uname,
    content: text,
    guardLevel: Number(info[7] || 0),
    medalName: String(info[3]?.[1] || ''),
    medalLevel: Number(info[3]?.[0] || 0),
    color: Number(info[0]?.[3] || 16777215),
    fontSize: Number(info[0]?.[2] || 25),
    mode: Number(info[0]?.[1] || 1),
  }, timestamp)
}

function handleGift(bot: BiliLiveBot, message: any): void {
  const data = message.data ?? {}
  const key = String(data.batch_combo_id || data.tid || `${data.uid}_${data.giftId}_${data.timestamp || Date.now()}`)
  // Web 协议的 combo 字段总是给出最新累计值，直接替换
  trackGiftCombo(bot, key, data, () => Number(data.combo_num || data.super_batch_gift_num || data.num || 1), (latest, totalNum) => {
    const timestamp = toMilliseconds(latest.timestamp)
    const uid = String(latest.uid ?? '')
    const uname = String(latest.uname ?? '')
    const giftName = String(latest.giftName ?? latest.gift_name ?? '')
    bot.rememberMember(uid, uname, latest.face)
    bot.dispatch(bot.session({
      type: 'bililive-gift',
      timestamp,
      ...roomScopes(bot),
      user: { id: uid, name: uname, avatar: latest.face },
      message: {
        id: String(latest.tid || key),
        content: `[礼物] ${uname} 赠送 ${giftName} x${totalNum}`,
        elements: [h('bililive:gift', {
          giftId: latest.giftId,
          giftName,
          giftNum: totalNum,
          price: latest.price,
          paid: latest.coin_type === 'gold',
        })],
        timestamp,
      },
    }))
    bot.dispatchCustom('bililive/gift', { ...latest, giftNum: totalNum }, timestamp)
  })
}

function handleSuperChat(bot: BiliLiveBot, message: any): void {
  const data = message.data ?? {}
  const timestamp = toMilliseconds(data.start_time)
  bot.dispatch(bot.session({
    type: 'bililive-superchat',
    timestamp,
    ...roomScopes(bot),
    user: { id: String(data.uid ?? ''), name: data.user_info?.uname, avatar: data.user_info?.face },
    message: {
      id: `sc_${data.id}`,
      content: String(data.message ?? ''),
      elements: [h('bililive:superchat', { price: data.price, duration: data.time, message: data.message })],
      timestamp,
    },
  }))
  bot.dispatchCustom('bililive/superchat', data, timestamp)
}

function handleGuard(bot: BiliLiveBot, message: any): void {
  const data = message.data ?? {}
  const timestamp = toMilliseconds(data.start_time)
  const guardName = GUARD_NAMES[data.guard_level] || `等级${data.guard_level}`
  bot.dispatch(bot.session({
    type: 'bililive-guard',
    timestamp,
    ...roomScopes(bot),
    user: { id: String(data.uid ?? ''), name: data.username },
    message: {
      id: `guard_${data.uid}_${data.start_time}`,
      content: `[上舰] ${data.username} 开通 ${guardName} x${data.num}`,
      elements: [h('bililive:guard', { guardLevel: data.guard_level, guardName, guardNum: data.num })],
      timestamp,
    },
  }))
  bot.dispatchCustom('bililive/guard', { ...data, guardName }, timestamp)
}

function handleInteract(bot: BiliLiveBot, message: any): void {
  const data = message.data ?? {}
  const timestamp = toMilliseconds(data.timestamp)
  if (data.msg_type === 1) {
    const uid = String(data.uid ?? '')
    const uname = String(data.uname ?? '')
    const uface = String(data.uface ?? '')
    if (uid) {
      bot.rememberMember(uid, uname, uface)
      // 派发标准 guild-member-added 事件，让欢迎类插件触发
      bot.dispatch(bot.session({
        type: 'guild-member-added',
        timestamp,
        ...roomScopes(bot),
        user: { id: uid, name: uname, avatar: uface },
      }))
    }
    bot.dispatchCustom('bililive/enter', data, timestamp)
  } else if (data.msg_type === 2 || data.msg_type === 4) {
    bot.dispatchCustom('bililive/follow', data, timestamp)
  } else if (data.msg_type === 6) {
    bot.dispatchCustom('bililive/like', data, timestamp)
  }
}

export function dispatchWebEvent(bot: BiliLiveBot, command: string, message: any): void {
  if (command.startsWith('DANMU_MSG')) return handleDanmaku(bot, message)
  switch (command) {
    case 'SEND_GIFT': return handleGift(bot, message)
    case 'SUPER_CHAT_MESSAGE':
    case 'SUPER_CHAT_MESSAGE_JP': return handleSuperChat(bot, message)
    case 'GUARD_BUY': return handleGuard(bot, message)
    case 'INTERACT_WORD': return handleInteract(bot, message)
    case 'LIVE':
      bot.dispatchCustom('bililive/live-start', message.data ?? {})
      return
    case 'PREPARING':
      bot.dispatchCustom('bililive/live-end', message.data ?? {})
      return
    case 'CUT_OFF':
      bot.dispatchCustom('bililive/cut-off', message.data ?? {})
      return
    case 'WARNING':
      bot.dispatchCustom('bililive/warning', { msg: message.data?.msg || message.msg || '' })
      return
    case 'WATCHED_CHANGE':
      bot.dispatchCustom('bililive/watched-change', { count: Number(message.data?.num || 0) })
      return
    default:
      bot.logger.debug('未处理的 Web 弹幕事件：%s', command)
  }
}
