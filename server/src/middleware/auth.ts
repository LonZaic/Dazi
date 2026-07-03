// ============================================================
// auth.ts — 认证中间件（从 httpOnly cookie 取 JWT，注入 req.user）
// 文件路径：server/src/middleware/auth.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  每个需要登录才能用的接口，前面都挂这个中间件。             ║
// ║  它干的事：从 cookie 里取 JWT → 解密 → 查用户 → 挂到 req.user ║
// ║  后面的路由代码就能直接用 req.user.id / req.user.tenantId    ║
// ║                                                            ║
// ║  两个版本：                                                 ║
// ║   - requireAuth：必须登录，没登录 → 401 错误                ║
// ║   - optionalAuth：登录了就注入，没登录也不报错（公开接口）   ║
// ╚══════════════════════════════════════════════════════════╝
//
// 【关键 TS 语法点】
//   - declare global → 扩展全局类型（给 Express.Request 加 user 属性）
//   - namespace Express → Express 的类型命名空间
//   - req.cookies?.[name] → 可选链取 cookie（cookie-parser 解析的）
//   - next() → 调用下一个中间件/路由
// ============================================================

import type { Request, Response, NextFunction } from 'express'  // type import：只导类型，编译后消失
import { authCookieName, verifyToken, getUserById, type AuthUser } from '../services/auth.js'
//     ↑ 从 auth 服务导入：cookie 名、验证 JWT 函数、按 ID 查用户函数、用户类型

// 【类型扩展】给 Express 的 Request 加一个 user 属性
// 原生 Express.Request 没有 user 字段，这里用 declare global 扩展
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser  // 可选：requireAuth 后必有，optionalAuth 可能没有
    }
  }
}

// 【中间件】requireAuth — 强制鉴权（必须登录）
// 文件路径：server/src/middleware/auth.ts → requireAuth()
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // 1. 从 cookie 取 JWT token（cookie-parser 已解析到 req.cookies）
  const token = req.cookies?.[authCookieName] as string | undefined
  //     ↑ ?. 可选链：cookies 不存在就不报错
  if (!token) {
    res.status(401).json({ error: '未登录' })  // 401 = 未授权
    return  // return 很重要：阻止后续代码执行
  }

  // 2. 验证 JWT 签名 + 解密
  const payload = verifyToken(token)
  if (!payload) {
    // token 无效（过期/篡改/伪造）→ 清掉 cookie + 401
    res.clearCookie(authCookieName)
    res.status(401).json({ error: '登录已过期' })
    return
  }

  // 3. 按 payload 里的用户 ID 查库，确认用户还存在
  const user = getUserById(payload.sub)
  //                           ↑ sub 是 JWT 标准字段：subject = 用户 ID
  if (!user) {
    res.status(401).json({ error: '用户不存在' })  // 用户已被删除
    return
  }

  // 4. 注入用户信息到 req，放行给下一个中间件/路由
  req.user = user
  next()  // 调用下一个中间件或路由处理函数
}

// 【中间件】optionalAuth — 可选鉴权（有就注入，没有不报错）
// 用于：公开接口（如 /health、/info），登录了就带上用户信息，没登录也能用
// 文件路径：server/src/middleware/auth.ts → optionalAuth()
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[authCookieName] as string | undefined
  if (token) {
    // 有 token → 尝试验证
    const payload = verifyToken(token)
    if (payload) {
      const user = getUserById(payload.sub)
      if (user) req.user = user  // 验证成功 → 注入
      // 验证失败 → 静默跳过（不报错，因为这是"可选"鉴权）
    }
  }
  next()  // 无论有没有 token，都放行
}
