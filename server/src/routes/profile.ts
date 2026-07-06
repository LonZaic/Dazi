// ============================================================
// profile.ts — 画像路由（可解释画像查看）
// 文件路径：server/src/routes/profile.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  用户想看"AI 画像我成什么样了"？调这组接口。                ║
// ║   - GET /api/profile：返回当前画像（兴趣/风格/目标/置信度） ║
// ║   - GET /api/profile/history：画像变更历史（每次怎么更新）  ║
// ║  "可解释推荐"是课题亮点：                                   ║
// ║  用户能看到"AI 为什么这样画像我"——每次更新都有证据原话。    ║
// ║  不是黑箱，隐私透明。                                       ║
// ╚══════════════════════════════════════════════════════════╝
//
// 【关键 TS 语法点】
//   - requireAuth 中间件 → req.user!.id 取当前用户
//   - JSON.parse(row.patch_json) → 把 DB 里的 JSON 字符串解析回对象
//   - res.json() → Express 返回 JSON 响应
// ============================================================

import { Router } from 'express'  // Express 路由
import { requireAuth } from '../middleware/auth.js'  // 鉴权中间件
import { loadProfile, profileToText } from '../agents/profileAgent.js'  // 画像加载+转文本
import { getDB } from '../db/index.js'  // 数据库连接

// 文件路径：server/src/routes/profile.ts → profileRouter
export const profileRouter = Router()  // 创建路由器

// GET / — 查看当前画像
profileRouter.get('/', requireAuth, (req, res) => {
  const profile = loadProfile(req.user!.id)  // 从 DB 加载画像
  if (!profile) {
    res.json({
      profile: null,
      confidence: 0,
      profileText: '',
      mbti: null,
      message: '还没有画像，去聊聊吧',
    })
    return
  }
  // MBTI
  let mbti: { type: string; confidence: number; partial: string | null } | null = null
  try {
    const { getMbtiProfile } = require('../integrations/mbtiProfileAdapter.js')
    const mp = getMbtiProfile(req.user!.id)
    if (mp) {
      const dims = mp.dimensions || []
      const ei = dims.find((d: any) => d.dimension === 'EI')
      const sn = dims.find((d: any) => d.dimension === 'SN')
      const tf = dims.find((d: any) => d.dimension === 'TF')
      const jp = dims.find((d: any) => d.dimension === 'JP')
      const char = (dim: any) => (dim && dim.confidence >= 0.5) ? dim.pole : '_'
      const partial = `${char(ei)}${char(sn)}${char(tf)}${char(jp)}`
      mbti = {
        type: mp.type !== 'UNKNOWN' ? mp.type : partial.replace(/_/g, ''),
        confidence: mp.confidence,
        partial,
      }
    }
  } catch { /* ignore */ }
  res.json({
    profile,
    confidence: profile.confidence,
    profileText: profileToText(profile),
    mbti,
  })
})

// GET /history — 画像变更历史（可解释：每次怎么更新的）
//   返回每次 patch（增量更新），用户能看到"AI 第几轮从我的话里提取了什么"
profileRouter.get('/history', requireAuth, (req, res) => {
  const db = getDB()
  // 查 profile_patches 表（每次画像更新都存一条审计记录）
  // ORDER BY id ASC：按插入顺序排（id 自增 = 时间顺序）
  const rows = db.prepare(`
    SELECT version, patch_json, created_at FROM profile_patches
    WHERE user_id = ? ORDER BY id ASC
  `).all(req.user!.id) as Array<{ version: number; patch_json: string; created_at: number }>

  res.json({
    history: rows.map(r => ({
      version: r.version,                    // 画像版本号（第几次更新）
      patch: JSON.parse(r.patch_json),       // 这轮提取了什么（兴趣/风格/目标...）
      createdAt: r.created_at,               // 更新时间
    })),
  })
})

// ════════════════════════════════════════════════════════════
//  【用户主页】GET /:userId/public — 查看他人公开主页
// ════════════════════════════════════════════════════════════
//   场景：私聊时点对方头像 → 查看对方主页
//   返回：用户基础信息 + 公开画像 + MBTI 类型
//   权限：登录用户即可查看（不做严格限制，简洁优先）
profileRouter.get('/:userId/public', requireAuth, (req, res) => {
  const targetUserId = req.params.userId
  const db = getDB()

  // ① 用户基础信息
  const userRow = db.prepare(`
    SELECT id, username, display_name, tenant_id, created_at
    FROM users WHERE id = ?
  `).get(targetUserId) as
    { id: string; username: string; display_name: string; tenant_id: string; created_at: number } | undefined

  if (!userRow) {
    res.status(404).json({ error: '用户不存在' })
    return
  }

  // ② 画像（如果有）
  const profile = loadProfile(targetUserId)

  // ③ MBTI 画像（从 mbtiProfileAdapter 拿）
  let mbti: { type: string; confidence: number; partial: string | null } | null = null
  try {
    const { getMbtiProfile } = require('../integrations/mbtiProfileAdapter.js')
    const mbtiProfile = getMbtiProfile(targetUserId)
    if (mbtiProfile) {
      // 已测到的字母逐个显示，未测的用 _ 占位
      const dims = mbtiProfile.dimensions || []
      const ei = dims.find((d: any) => d.dimension === 'EI')
      const sn = dims.find((d: any) => d.dimension === 'SN')
      const tf = dims.find((d: any) => d.dimension === 'TF')
      const jp = dims.find((d: any) => d.dimension === 'JP')
      const char = (dim: any) => (dim && dim.confidence >= 0.5) ? dim.pole : '_'
      const partial = `${char(ei)}${char(sn)}${char(tf)}${char(jp)}`
      mbti = {
        type: mbtiProfile.type !== 'UNKNOWN' ? mbtiProfile.type : partial.replace(/_/g, ''),
        confidence: mbtiProfile.confidence,
        partial,  // 如 "IN__" — 已测到的字母显示，未测的用 _
      }
    }
  } catch {
    // mbtiProfileAdapter 未加载 → 跳过
  }

  // ④ 用户自定义主页信息（从 user_home 表读，无则用默认）
  let homeCustom: { bio: string; avatarColor: string; avatarUrl?: string; tags: string[]; likes: number; city?: string; genderPref?: string; ageRange?: any } | null = null
  try {
    const homeRow = db.prepare(`
      SELECT display_name, bio, avatar_color, avatar_url, tags, likes, city, gender_pref, age_range FROM user_home WHERE user_id = ?
    `).get(targetUserId) as
      { display_name: string | null; bio: string | null; avatar_color: string | null; avatar_url: string | null; tags: string | null; likes: number | null; city: string | null; gender_pref: string | null; age_range: string | null } | undefined
    if (homeRow) {
      let ageRange: any = null
      if (homeRow.age_range) { try { ageRange = JSON.parse(homeRow.age_range) } catch {} }
      homeCustom = {
        bio: homeRow.bio || '',
        avatarColor: homeRow.avatar_color || '',
        avatarUrl: homeRow.avatar_url || '',
        tags: homeRow.tags ? JSON.parse(homeRow.tags) : [],
        likes: homeRow.likes || 0,
        city: homeRow.city || '',
        genderPref: homeRow.gender_pref || '',
        ageRange,
      }
    }
  } catch {
    // user_home 表可能未建，忽略
  }

  res.json({
    user: {
      id: userRow.id,
      username: userRow.username,
      displayName: userRow.display_name,
      createdAt: userRow.created_at,
    },
    // 只暴露公开画像，不暴露证据链、隐私原始数据
    profile: profile ? {
      interests: profile.interests?.map(i => ({ name: i.name, confidence: i.confidence })) || [],
      socialStyle: profile.socialStyle,
      schedule: profile.schedule,
      goal: profile.goal,
      confidence: profile.confidence,
    } : null,
    mbti,
    home: homeCustom,
  })
})

// ════════════════════════════════════════════════════════════
//  【用户主页】PUT /home — 设定自己的主页
//   字段：displayName / bio / avatarColor / tags
// ════════════════════════════════════════════════════════════
profileRouter.put('/home', requireAuth, (req, res) => {
  const { displayName, bio, avatarColor, tags, city, genderPref, ageRange } = req.body || {}
  const userId = req.user!.id
  const tenantId = req.user!.tenantId
  const db = getDB()

  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_home (
      user_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      display_name TEXT,
      bio TEXT,
      avatar_color TEXT,
      avatar_url TEXT,
      tags TEXT,
      city TEXT,
      gender_pref TEXT,
      age_range TEXT,
      updated_at INTEGER
    )
  `).run()

  try { db.prepare('ALTER TABLE user_home ADD COLUMN display_name TEXT').run() } catch {}
  try { db.prepare('ALTER TABLE user_home ADD COLUMN city TEXT').run() } catch {}
  try { db.prepare('ALTER TABLE user_home ADD COLUMN gender_pref TEXT').run() } catch {}
  try { db.prepare('ALTER TABLE user_home ADD COLUMN age_range TEXT').run() } catch {}

  const exists = db.prepare('SELECT 1 FROM user_home WHERE user_id = ?').get(userId)
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags.slice(0, 10)) : '[]'
  const dn = (displayName && typeof displayName === 'string') ? displayName.trim().slice(0, 24) : ''
  const b = (bio && typeof bio === 'string') ? bio.trim().slice(0, 80) : ''
  const avc = (avatarColor && typeof avatarColor === 'string') ? avatarColor : ''
  const c = (city && typeof city === 'string') ? city.trim().slice(0, 32) : ''
  const gp = (genderPref && typeof genderPref === 'string') ? genderPref : ''
  const ar = ageRange ? JSON.stringify(ageRange) : ''
  const now = Date.now()

  if (exists) {
    const sets: string[] = []
    const vals: any[] = []
    if (dn !== undefined) { sets.push('display_name = ?'); vals.push(dn) }
    if (bio !== undefined) { sets.push('bio = ?'); vals.push(b) }
    if (avc !== undefined) { sets.push('avatar_color = ?'); vals.push(avc) }
    sets.push('tags = ?'); vals.push(tagsJson)
    sets.push('city = ?'); vals.push(c)
    sets.push('gender_pref = ?'); vals.push(gp)
    sets.push('age_range = ?'); vals.push(ar)
    sets.push('updated_at = ?'); vals.push(now)
    vals.push(userId)
    db.prepare(`UPDATE user_home SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals)
  } else {
    db.prepare(`
      INSERT INTO user_home (user_id, tenant_id, display_name, bio, avatar_color, tags, city, gender_pref, age_range, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, tenantId, dn, b, avc, tagsJson, c, gp, ar, now)
  }

  // 同步 displayName 到 users 表（侧栏/DM/AI 对话取这里）
  if (dn) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(dn, userId)
  }

  res.json({
    ok: true,
    home: { displayName: dn, bio: b, avatarColor: avc, tags: Array.isArray(tags) ? tags.slice(0, 10) : [], city: c, genderPref: gp, ageRange },
  })
})

// ════════════════════════════════════════════════════════════
//  【用户主页】GET /home/me — 拿自己的主页设定
// ════════════════════════════════════════════════════════════
profileRouter.get('/home/me', requireAuth, (req, res) => {
  const db = getDB()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_home (
      user_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      display_name TEXT,
      bio TEXT,
      avatar_color TEXT,
      avatar_url TEXT,
      tags TEXT,
      city TEXT,
      gender_pref TEXT,
      age_range TEXT,
      updated_at INTEGER
    )
  `).run()

  try { db.prepare('ALTER TABLE user_home ADD COLUMN display_name TEXT').run() } catch {}
  try { db.prepare('ALTER TABLE user_home ADD COLUMN avatar_url TEXT').run() } catch {}
  try { db.prepare('ALTER TABLE user_home ADD COLUMN city TEXT').run() } catch {}
  try { db.prepare('ALTER TABLE user_home ADD COLUMN gender_pref TEXT').run() } catch {}
  try { db.prepare('ALTER TABLE user_home ADD COLUMN age_range TEXT').run() } catch {}

  const row = db.prepare(`
    SELECT display_name, bio, avatar_color, avatar_url, tags, city, gender_pref, age_range FROM user_home WHERE user_id = ?
  `).get(req.user!.id) as
    { display_name: string | null; bio: string | null; avatar_color: string | null; avatar_url: string | null; tags: string | null; city: string | null; gender_pref: string | null; age_range: string | null } | undefined

  let ageRange: any = null
  if (row?.age_range) {
    try { ageRange = JSON.parse(row.age_range) } catch {}
  }

  res.json({
    home: row ? {
      displayName: row.display_name || '',
      bio: row.bio || '',
      avatarColor: row.avatar_color || '',
      avatarUrl: row.avatar_url || '',
      tags: row.tags ? JSON.parse(row.tags) : [],
      city: row.city || '',
      genderPref: row.gender_pref || '',
      ageRange,
    } : { displayName: '', bio: '', avatarColor: '', avatarUrl: '', tags: [], city: '', genderPref: '', ageRange: null },
  })
})
