// ============================================================
// rateLimiter.ts — 限流器（防滥用，省钱，基于 SQLite 滑动小时窗）
// 文件路径：server/src/services/rateLimiter.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是"流量警察"——每个用户每小时最多发 30 条消息。       ║
// ║  超了返回 429（"对话太频繁，稍后再试"）。                    ║
// ║                                                            ║
// ║  为什么需要限流？                                            ║
// ║  1. 省钱：每条消息调 LLM 花 token（约 0.01 元/条）            ║
// ║     脚本狂刷 1 万条 = 烧 100 元                             ║
// ║  2. 防滥用：防止有人写脚本刷接口                              ║
// ║  3. 公平：单用户不能占满 LLM 配额                            ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王第 31 条消息被限流 ▼▼▼
//
//   小王这小时已经发了 30 条消息
//        │
//        ▼
//   POST /api/chat/messages → chat.ts
//        │
//        ▼
//   consumeRateLimit('小王ID')
//        │
//        ├── hourBucket = Math.floor(Date.now() / 3600000) = 485932
//        ├── key = "小王ID:hour:485932"
//        ├── SELECT count FROM rate_counters WHERE key = ? → 30
//        ├── 30 >= 30（超限）→ 拒绝
//        └── 返回 { allowed:false, remaining:0, retryAfterSec:1800 }
//        │
//        ▼
//   chat.ts 收到 allowed=false → 返回 HTTP 429
//   前端显示"对话太频繁，30 分钟后可重试"
//
//   小王第 1 条消息（新小时桶）：
//        ├── key = "小王ID:hour:485933"（新桶）
//        ├── SELECT → 没记录 → current = 0
//        ├── 0 < 30 → 允许
//        ├── INSERT rate_counters (key, count=1, expires_at)
//        └── 返回 { allowed:true, remaining:29, retryAfterSec:0 }
//
// ════════════════════════════════════════════════════════════
//  【滑动小时窗 vs 固定小时窗】
// ════════════════════════════════════════════════════════════
//   固定小时窗：从 0 点开始计，0:00 重置
//     问题：23:59 发 30 条 + 0:01 发 30 条 = 1 分钟发 60 条（钻空子）
//   滑动小时窗：从当前时间往前推 1 小时计
//     本系统用"小时桶"近似：按整点分桶，每个桶独立计数
//     简单、够用、过期自动清理
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   用户发消息 → chat.ts → consumeRateLimit() → 允许/拒绝
//   用户发私信 → dm.ts → consumeRateLimit() → 允许/拒绝
//   前端查状态 → chat.ts /status → peekRateLimit() → 显示剩余次数
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - routes/chat.ts: consumeRateLimit（发消息前检查）
//                    peekRateLimit（查剩余次数）
//   - routes/dm.ts: consumeRateLimit（发私信前检查）
//
//   它调用：
//   - db/index.js → getDB（读写 rate_counters 表）
//   - config/index.js → config.rateLimitPerHour（每小时上限）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - Math.floor(now / HOUR_MS) → 算当前是第几个"小时桶"
//   - db.prepare().get(key) → SQL 单行查询
//   - ? ：SQL 参数化查询，防止 SQL 注入
// ============================================================

import { getDB } from '../db/index.js'
import { config } from '../config/index.js'

const HOUR_MS = 3600 * 1000  // 1 小时 = 3600000 毫秒

// 【函数】检查并消耗一个配额
//   @returns { allowed: 是否允许, remaining: 剩余次数, retryAfterSec: 几秒后能重试 }
// 文件路径：server/src/services/rateLimiter.ts → consumeRateLimit()
export function consumeRateLimit(userId: string): {
  allowed: boolean
  remaining: number
  retryAfterSec: number
} {
  const db = getDB()
  const now = Date.now()

  // 算当前是哪个"小时桶"（从 1970.1.1 UTC 开始算起，第几个整小时）
  const hourBucket = Math.floor(now / HOUR_MS)

  // key 格式："用户ID:hour:桶编号"（如 "abc123:hour:485932"）
  const key = `${userId}:hour:${hourBucket}`
  const expiresAt = (hourBucket + 1) * HOUR_MS  // 这个桶的过期时间（下一个整点）

  // 惰性清理：顺便删掉已经过期的记录（避免 DB 膨胀）
  db.prepare('DELETE FROM rate_counters WHERE expires_at < ?').run(now)

  // 查当前桶的已用次数
  const row = db.prepare('SELECT count FROM rate_counters WHERE key = ?').get(key) as { count: number } | undefined
  const current = row?.count || 0  // 没记录 = 0 次

  // 超限 → 拒绝
  if (current >= config.rateLimitPerHour) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.ceil((expiresAt - now) / 1000),
      //              ↑ 距离下个整点还有多少秒
    }
  }

  // 没超 → 消耗 1 次
  if (row) {
    // 已有记录 → 次数 +1
    db.prepare('UPDATE rate_counters SET count = count + 1 WHERE key = ?').run(key)
  } else {
    // 没有记录 → 新建一条，count=1
    db.prepare('INSERT INTO rate_counters (key, count, expires_at) VALUES (?, 1, ?)').run(key, expiresAt)
  }

  return {
    allowed: true,
    remaining: config.rateLimitPerHour - current - 1,  // 剩余 = 上限 - 已用 - 本次消耗的 1
    retryAfterSec: 0,
  }
}

// 【函数】查询当前剩余配额（不消耗，只读）
//   聊天页面加载时调一次，显示剩余次数
// 文件路径：server/src/services/rateLimiter.ts → peekRateLimit()
export function peekRateLimit(userId: string): { remaining: number; limit: number } {
  const db = getDB()
  const now = Date.now()
  const hourBucket = Math.floor(now / HOUR_MS)
  const key = `${userId}:hour:${hourBucket}`
  const row = db.prepare('SELECT count FROM rate_counters WHERE key = ?').get(key) as { count: number } | undefined
  const used = row?.count || 0
  return {
    remaining: Math.max(0, config.rateLimitPerHour - used),
    limit: config.rateLimitPerHour,
  }
}
