// ============================================================
// privacy.ts — 隐私路由（PIPL/GDPR 合规：数据导出 + 一键删除）
// 文件路径：server/src/routes/privacy.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这是"最高等级隐私"的落地：                                  ║
// ║   - GET /export：所有数据打包成 JSON 下载（对话/画像/匹配）║
// ║   - DELETE /account：一键删除账号 + 所有关联数据（级联删除）║
// ║                                                            ║
// ║  为什么需要这个？                                           ║
// ║  中国《个人信息保护法》(PIPL) 和欧洲 GDPR 都要求：           ║
// ║  用户有权导出自己的数据 + 有权要求删除。                    ║
// ║  没这个功能 = 违法。                                        ║
// ╚══════════════════════════════════════════════════════════╝
//
// 【关键 TS 语法点】
//   - res.setHeader('Content-Disposition', ...) → 设置下载文件名
//   - ON DELETE CASCADE → 外键级联删除（删用户自动删关联数据）
//   - audit_log → 审计日志（删之前先记录，留痕）
// ============================================================

import { Router } from 'express'  // Express 路由
import { requireAuth } from '../middleware/auth.js'  // 鉴权中间件
import { getDB } from '../db/index.js'  // 数据库连接
import { resetSession } from '../core/orchestrator.js'  // 重置会话状态

// 文件路径：server/src/routes/privacy.ts → privacyRouter
export const privacyRouter = Router()  // 创建路由器

// GET /export — 导出我的全部数据（合规要求：用户有权获取自己的数据）
privacyRouter.get('/export', requireAuth, (req, res) => {
  const db = getDB()
  const userId = req.user!.id  // 当前登录用户 ID

  // 查对话记录（用户说的 + AI 回的，全部）
  const conversations = db.prepare(
    'SELECT role, content, created_at FROM conversations WHERE user_id = ? ORDER BY id'
  ).all(userId)

  // 查画像（当前合并版）
  const profile = db.prepare('SELECT profile_json, confidence, version, updated_at FROM profiles WHERE user_id = ?').get(userId)

  // 查画像变更历史（每次增量 patch，可追溯"AI 怎么画像我的"）
  const patches = db.prepare('SELECT version, patch_json, created_at FROM profile_patches WHERE user_id = ? ORDER BY id').all(userId)

  // 查匹配记录
  const matches = db.prepare('SELECT user_b, score, factors_json, explanation, state, created_at FROM matches WHERE user_a = ?').all(userId)

  // 设置响应头：浏览器会弹下载框，文件名 "my-data-用户ID.json"
  res.setHeader('Content-Disposition', `attachment; filename="my-data-${userId}.json"`)
  res.json({
    exportedAt: new Date().toISOString(),  // 导出时间
    user: { id: req.user!.id, username: req.user!.username, displayName: req.user!.displayName },
    profile,           // 当前画像
    profilePatches: patches,  // 画像变更历史
    conversations,     // 所有对话
    matches,           // 匹配记录
  })
})

// DELETE /account — 一键删除账号 + 所有数据（合规要求：用户有权被遗忘）
privacyRouter.delete('/account', requireAuth, (req, res) => {
  const db = getDB()
  const userId = req.user!.id
  const tenantId = req.user!.tenantId

  // ① 审计日志（先记，删后留痕——合规要求"删除操作可追溯"）
  db.prepare(`
    INSERT INTO audit_log (actor, action, target, meta_json)
    VALUES (?, 'delete_account', ?, ?)
  `).run(userId, userId, JSON.stringify({ tenantId, at: Date.now() }))

  // ② 删除用户（外键 ON DELETE CASCADE 自动删：画像/对话/匹配/私信...全部级联删）
  db.prepare('DELETE FROM users WHERE id = ?').run(userId)

  // ③ 重置内存中的会话状态（orchestrator 的 Map 里清掉）
  resetSession(userId)

  // ④ 清掉 cookie（已删号，token 无效了）
  res.clearCookie('mm_token')
  res.json({ ok: true, message: '账号及所有数据已删除' })
})
