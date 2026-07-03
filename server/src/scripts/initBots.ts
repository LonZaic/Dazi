// 初始化 AI Bot，注册并互相匹配（让用户能在匹配结果里看到他们并发私信）
import { getDB, closeDB } from '../db/index.js'
import { registerUser } from '../services/auth.js'

const BOTS = [
  { username: 'alice_intj', displayName: 'Alice', mbti: 'INTJ' },
  { username: 'bob_enfp', displayName: 'Bob', mbti: 'ENFP' },
  { username: 'carol_isfj', displayName: 'Carol', mbti: 'ISFJ' },
  { username: 'david_entp', displayName: 'David', mbti: 'ENTP' },
]

const db = getDB()

// 注册（幂等：已存在就跳过）
for (const b of BOTS) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(b.username) as any
  if (!existing) {
    const u = registerUser({
      username: b.username,
      password: 'test12345',
      displayName: b.displayName,
    })
    console.log(`✅ 注册 Bot: ${b.displayName} (${b.username}) → ${u.id}`)
  } else {
    console.log(`⏭ 已存在，跳过: ${b.displayName} (${b.username})`)
  }
}

// 互相匹配（让用户在匹配结果里能看到 4 个 Bot）
const botIds = db.prepare(`SELECT id, username FROM users WHERE username IN ('alice_intj','bob_enfp','carol_isfj','david_entp')`).all() as Array<{ id: string; username: string }>

const tenantId = 'default'
const now = Math.floor(Date.now() / 1000)
let count = 0

// user_a < user_b 保证唯一匹配
for (let i = 0; i < botIds.length; i++) {
  for (let j = i + 1; j < botIds.length; j++) {
    const [a, b] = botIds[i].id < botIds[j].id
      ? [botIds[i].id, botIds[j].id]
      : [botIds[j].id, botIds[i].id]
    const ex = db.prepare('SELECT 1 FROM matches WHERE tenant_id = ? AND user_a = ? AND user_b = ?')
      .get(tenantId, a, b)
    if (!ex) {
      db.prepare(`INSERT INTO matches (tenant_id, user_a, user_b, score, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(tenantId, a, b, 0.85, now)
      count++
    }
  }
}

// 也把当前用户（如果有）和 Bot 配一下
const realUsers = db.prepare(`SELECT id, username FROM users WHERE username NOT IN ('alice_intj','bob_enfp','carol_isfj','david_entp')`).all() as Array<{ id: string; username: string }>
for (const realUser of realUsers) {
  for (const bot of botIds) {
    const [a, b] = realUser.id < bot.id ? [realUser.id, bot.id] : [bot.id, realUser.id]
    const ex = db.prepare('SELECT 1 FROM matches WHERE tenant_id = ? AND user_a = ? AND user_b = ?')
      .get(tenantId, a, b)
    if (!ex) {
      db.prepare(`INSERT INTO matches (tenant_id, user_a, user_b, score, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(tenantId, a, b, 0.85, now)
      count++
    }
  }
}

console.log(`✅ 建立了 ${count} 条新匹配`)
closeDB()
