// ============================================================
// avatar.ts — 头像上传路由
// 文件路径：server/src/routes/avatar.ts
// ============================================================
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { getDB } from '../db/index.js'

export const avatarRouter = Router()

// POST /api/avatar — 上传用户头像（base64 dataURL）
avatarRouter.post('/', requireAuth, (req, res) => {
  const { image } = req.body || {}
  const userId = req.user!.id

  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: '缺少图片数据' })
    return
  }

  // 限制 3MB（base64 大约比原始大 33%）
  if (image.length > 3 * 1024 * 1024) {
    res.status(400).json({ error: '图片过大，上限 2MB' })
    return
  }

  const db = getDB()

  // 建表（首次）
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_home (
      user_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      bio TEXT,
      avatar_color TEXT,
      avatar_url TEXT,
      tags TEXT,
      updated_at INTEGER
    )
  `).run()

  // 兼容旧表：加 avatar_url 列
  try { db.prepare('ALTER TABLE user_home ADD COLUMN avatar_url TEXT').run() } catch {}

  const exists = db.prepare('SELECT 1 FROM user_home WHERE user_id = ?').get(userId)
  const now = Date.now()

  if (exists) {
    db.prepare('UPDATE user_home SET avatar_url = ?, updated_at = ? WHERE user_id = ?')
      .run(image, now, userId)
  } else {
    db.prepare(`
      INSERT INTO user_home (user_id, tenant_id, avatar_url, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, req.user!.tenantId, image, now)
  }

  res.json({ ok: true })
})
