// ============================================================
// auth.ts — 认证路由（注册/登录/登出/当前用户）
// 文件路径：server/src/routes/auth.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  前端登录注册页面调的接口全在这。                            ║
// ║   - 注册：POST /api/auth/register → 创建用户 + 发 cookie    ║
// ║   - 登录：POST /api/auth/login → 验密码 + 发 cookie         ║
// ║   - 登出：POST /api/auth/logout → 清 cookie                 ║
// ║   - 查当前用户：GET /api/auth/me → 返回登录用户信息         ║
// ║                                                            ║
// ║  安全设计：                                                 ║
// ║   - cookie 设 httpOnly（JS 读不到，防 XSS 偷 token）       ║
// ║   - cookie 设 secure（生产环境只走 HTTPS）                  ║
// ║   - cookie 设 sameSite（防 CSRF）                            ║
// ║   - 登录失败统一报"用户名或密码错误"（防枚举攻击）          ║
// ╚══════════════════════════════════════════════════════════╝
//
// 【关键 TS 语法点】
//   - res.cookie(name, value, options) → 设置响应 cookie
//   - process.env.NODE_ENV → 环境变量（production=生产）
//   - req.user! → 非空断言（requireAuth 保证有值）
// ============================================================

import { Router } from 'express'  // Express 路由
import {
  registerUser, loginUser, signToken, authCookieName, type AuthUser,
} from '../services/auth.js'      // 认证服务（注册/登录/签 token）
import { requireAuth } from '../middleware/auth.js'  // 鉴权中间件
import { getDB } from '../db/index.js'                  // DB 访问（读 user_home）

// 文件路径：server/src/routes/auth.ts → authRouter
export const authRouter = Router()  // 创建路由器

// 【工具函数】把 AuthUser 转成前端用的格式（不暴露 password_hash）
// 文件路径：server/src/routes/auth.ts → toPublicUser()
function toPublicUser(u: AuthUser) {
  return { id: u.id, username: u.username, displayName: u.displayName, tenantId: u.tenantId }
}

// POST /register — 注册
authRouter.post('/register', (req, res) => {
  const { username, password, displayName } = req.body || {}
  // ① 校验必填
  if (!username || !password) {
    res.status(400).json({ error: '用户名和密码必填' })
    return
  }
  try {
    // ② 注册（registerUser 内部会校验格式+查重+加密+写库）
    const user = registerUser({ username, password, displayName })
    // ③ 签发 JWT token
    const token = signToken({ sub: user.id, tenant: user.tenantId, username: user.username })
    // ④ 把 token 放到 httpOnly cookie 里返给浏览器
    res.cookie(authCookieName, token, {
      httpOnly: true,                              // JS 读不到（防 XSS 偷 token）
      sameSite: 'lax',                             // 防 CSRF（跨站请求不带 cookie）
      secure: process.env.NODE_ENV === 'production', // 生产环境只走 HTTPS
      maxAge: 7 * 24 * 3600 * 1000,               // 7 天有效期（毫秒）
    })
    res.json({ user: toPublicUser(user) })  // 返回用户信息（前端存到全局状态）
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })  // 注册失败（用户名占用/格式不对）
  }
})

// POST /login — 登录
authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    res.status(400).json({ error: '用户名和密码必填' })
    return
  }
  try {
    // loginUser 内部：查用户 → 验密码 → 返回用户信息
    const user = loginUser(username, password)
    const token = signToken({ sub: user.id, tenant: user.tenantId, username: user.username })
    res.cookie(authCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 3600 * 1000,
    })
    res.json({ user: toPublicUser(user) })
  } catch {
    // 统一错误信息防枚举（不告诉"用户不存在"还是"密码错误"）
    res.status(401).json({ error: '用户名或密码错误' })
  }
})

// POST /logout — 登出（清 cookie）
authRouter.post('/logout', (_req, res) => {
  res.clearCookie(authCookieName)  // 清掉浏览器里的 JWT cookie
  res.json({ ok: true })
})

// GET /me — 查当前登录用户（前端刷新页面时调，恢复登录状态）
//   同时从 user_home 取自定义显示名 + 头像 URL，确保侧栏/私信/AI 对话全部同步
authRouter.get('/me', requireAuth, (req, res) => {
  const user = toPublicUser(req.user!)
  // 查 user_home 表：覆盖 displayName + 补充 avatarUrl
  try {
    const db = getDB()
    const homeRow = db.prepare(
      'SELECT display_name, avatar_url, avatar_color FROM user_home WHERE user_id = ?'
    ).get(req.user!.id) as { display_name: string | null; avatar_url: string | null; avatar_color: string | null } | undefined
    if (homeRow) {
      if (homeRow.display_name) user.displayName = homeRow.display_name
      ;(user as any).avatarUrl = homeRow.avatar_url || ''
      ;(user as any).avatarColor = homeRow.avatar_color || '#6366f1'
    } else {
      ;(user as any).avatarUrl = ''
      ;(user as any).avatarColor = '#6366f1'
    }
  } catch { /* user_home 表可能不存在 */ }
  res.json({ user })
})
