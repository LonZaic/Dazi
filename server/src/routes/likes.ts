// ============================================================
// likes.ts — 用户主页点赞路由
// 文件路径：server/src/routes/likes.ts
// ============================================================
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { getDB } from '../db/index.js'

export const likesRouter = Router()

/** 确保 profile_likes 表和 user_home.likes 列存在 */
function ensureLikesSchema(db: ReturnType<typeof getDB>) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS profile_likes (
      user_id TEXT NOT NULL,
      liker_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, liker_id)
    )
  `).run()
  try { db.prepare('ALTER TABLE user_home ADD COLUMN likes INTEGER DEFAULT 0').run() } catch {}
}

/** 确保被点赞用户在 user_home 表有记录 */
function ensureUserHome(targetUserId: string, tenantId: string, db: ReturnType<typeof getDB>) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_home (
      user_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      bio TEXT,
      avatar_color TEXT,
      avatar_url TEXT,
      tags TEXT,
      likes INTEGER DEFAULT 0,
      updated_at INTEGER
    )
  `).run()

  if (!db.prepare('SELECT 1 FROM user_home WHERE user_id = ?').get(targetUserId)) {
    db.prepare('INSERT INTO user_home (user_id, tenant_id, likes, updated_at) VALUES (?, ?, 0, ?)')
      .run(targetUserId, tenantId, Date.now())
  }
}

// ─────────────────────────────────────────────────────
// GET /api/likes/:userId — 查询点赞状态和总数
// ─────────────────────────────────────────────────────
likesRouter.get('/:userId', requireAuth, (req, res) => {
  const targetUserId = req.params.userId
  const meId = req.user!.id
  const db = getDB()
  ensureLikesSchema(db)

  const count = (db.prepare('SELECT COUNT(*) as c FROM profile_likes WHERE user_id = ?')
    .get(targetUserId) as { c: number })?.c || 0
  const liked = !!db.prepare('SELECT 1 FROM profile_likes WHERE user_id = ? AND liker_id = ?')
    .get(targetUserId, meId)

  res.json({ liked, count })
})

// ─────────────────────────────────────────────────────
// POST /api/likes/:userId — 赞/取消赞（toggle）
// ─────────────────────────────────────────────────────
likesRouter.post('/:userId', requireAuth, (req, res) => {
  const targetUserId = req.params.userId
  const meId = req.user!.id
  const db = getDB()

  if (targetUserId === meId) {
    res.status(400).json({ error: '不能给自己点赞' })
    return
  }

  ensureLikesSchema(db)
  ensureUserHome(targetUserId, req.user!.tenantId, db)

  const existing = db.prepare('SELECT 1 FROM profile_likes WHERE user_id = ? AND liker_id = ?')
    .get(targetUserId, meId)

  if (existing) {
    // 取消点赞
    db.prepare('DELETE FROM profile_likes WHERE user_id = ? AND liker_id = ?').run(targetUserId, meId)
    db.prepare('UPDATE user_home SET likes = MAX(0, likes - 1), updated_at = ? WHERE user_id = ?')
      .run(Date.now(), targetUserId)
  } else {
    // 点赞
    db.prepare('INSERT INTO profile_likes (user_id, liker_id, created_at) VALUES (?, ?, ?)')
      .run(targetUserId, meId, Math.floor(Date.now() / 1000))
    db.prepare('UPDATE user_home SET likes = likes + 1, updated_at = ? WHERE user_id = ?')
      .run(Date.now(), targetUserId)
  }

  const count = (db.prepare('SELECT COUNT(*) as c FROM profile_likes WHERE user_id = ?')
    .get(targetUserId) as { c: number }).c
  const liked = !!db.prepare('SELECT 1 FROM profile_likes WHERE user_id = ? AND liker_id = ?')
    .get(targetUserId, meId)

  res.json({ liked, count })
})
