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
    // 没画像（新用户没聊过天）
    res.json({
      profile: null,
      confidence: 0,
      profileText: '',
      message: '还没有画像，去聊聊吧',
    })
    return
  }
  // 有画像 → 返回画像 + 置信度 + 文本版（前端可展示）
  res.json({
    profile,                           // 完整画像对象（兴趣/风格/目标/约束...）
    confidence: profile.confidence,    // 置信度（0-1，越高越了解用户）
    profileText: profileToText(profile), // 画像转纯文本（给用户看的人类可读版）
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
  let mbti: { type: string; confidence: number } | null = null
  try {
    const { getMbtiProfile } = require('../integrations/mbtiProfileAdapter.js')
    const mbtiProfile = getMbtiProfile(targetUserId)
    if (mbtiProfile && mbtiProfile.type !== 'UNKNOWN') {
      mbti = { type: mbtiProfile.type, confidence: mbtiProfile.confidence }
    }
  } catch {
    // mbtiProfileAdapter 未加载 → 跳过
  }

  // ④ 用户自定义主页信息（从 user_home 表读，无则用默认）
  let homeCustom: { bio: string; avatarColor: string; tags: string[] } | null = null
  try {
    const homeRow = db.prepare(`
      SELECT bio, avatar_color, tags FROM user_home WHERE user_id = ?
    `).get(targetUserId) as
      { bio: string | null; avatar_color: string | null; tags: string | null } | undefined
    if (homeRow) {
      homeCustom = {
        bio: homeRow.bio || '',
        avatarColor: homeRow.avatar_color || '',
        tags: homeRow.tags ? JSON.parse(homeRow.tags) : [],
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
    profile: profile ? {
      interests: profile.interests.map(i => ({ name: i.name, confidence: i.confidence })),
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
//  【用户主页】PUT /home — 设定自己的主页（bio / 头像色 / 标签）
// ════════════════════════════════════════════════════════════
//   场景：用户点自己头像 → 编辑主页
//   字段：bio（一句话简介）、avatarColor（头像底色）、tags（自定义标签数组）
profileRouter.put('/home', requireAuth, (req, res) => {
  const { bio, avatarColor, tags } = req.body || {}
  const userId = req.user!.id
  const tenantId = req.user!.tenantId
  const db = getDB()

  // 建表（首次使用时自动建）
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_home (
      user_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      bio TEXT,
      avatar_color TEXT,
      tags TEXT,
      updated_at INTEGER
    )
  `).run()

  // upsert
  const exists = db.prepare('SELECT 1 FROM user_home WHERE user_id = ?').get(userId)
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags.slice(0, 10)) : '[]'
  const now = Date.now()

  if (exists) {
    db.prepare(`
      UPDATE user_home SET bio = ?, avatar_color = ?, tags = ?, updated_at = ?
      WHERE user_id = ?
    `).run(bio || '', avatarColor || '', tagsJson, now, userId)
  } else {
    db.prepare(`
      INSERT INTO user_home (user_id, tenant_id, bio, avatar_color, tags, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, tenantId, bio || '', avatarColor || '', tagsJson, now)
  }

  res.json({
    ok: true,
    home: { bio: bio || '', avatarColor: avatarColor || '', tags: Array.isArray(tags) ? tags.slice(0, 10) : [] },
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
      bio TEXT,
      avatar_color TEXT,
      tags TEXT,
      updated_at INTEGER
    )
  `).run()

  const row = db.prepare(`
    SELECT bio, avatar_color, tags FROM user_home WHERE user_id = ?
  `).get(req.user!.id) as
    { bio: string | null; avatar_color: string | null; tags: string | null } | undefined

  res.json({
    home: row ? {
      bio: row.bio || '',
      avatarColor: row.avatar_color || '',
      tags: row.tags ? JSON.parse(row.tags) : [],
    } : { bio: '', avatarColor: '', tags: [] },
  })
})
