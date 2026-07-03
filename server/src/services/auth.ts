// ============================================================
// auth.ts — 认证服务（注册/登录/JWT/bcrypt，安全核心）
// 文件路径：server/src/services/auth.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是"门卫"——注册、登录、发身份证、查身份证。           ║
// ║                                                            ║
// ║  核心安全设计：                                              ║
// ║  1. 密码用 bcrypt 加密存（永远不会看到明文密码）              ║
// ║     cost=12 → 暴力破解成本极高（单次哈希 4096 轮迭代）        ║
// ║  2. 登录后发 JWT cookie（相当于"电子身份证"）                 ║
// ║     httpOnly → 浏览器 JS 读不到（防 XSS 偷 token）           ║
// ║     7 天有效期 → 过期需重新登录                              ║
// ║  3. 密码强度校验（至少 8 位，含字母+数字）                    ║
// ║  4. 用户名大小写不敏感（防 admin/Admin 注册搞枚举）           ║
// ║  5. 登录失败统一报"用户名或密码错误"（不告诉是哪个错）         ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王注册→登录→发消息，auth 链路 ▼▼▼
//
//   ① 注册
//   小王填用户名"xiaowang"+密码"Run12345"
//        │
//        ▼
//   POST /api/auth/register → registerUser()
//     - validateUsername() 校验格式（3-32 字符）
//     - validatePassword() 校验强度（≥8 位+字母+数字）
//     - 查重：lower(username) = lower('xiaowang')（大小写不敏感）
//     - hashPassword('Run12345') → bcrypt 哈希（cost=12）
//       → "$2a$12$N9qo8uLOickgx2ZMRZoMy..."
//     - INSERT users (id, username, password_hash, ...) → 写库
//     - signToken({ sub: userId, tenant, username }) → JWT 字符串
//     - res.cookie('mm_token', token, { httpOnly, maxAge:7天 })
//   前端拿到 { user: {id, username, displayName} } + cookie 自动存浏览器
//
//   ② 登录
//   小王下次打开页面，浏览器自动带 cookie
//        │
//        ▼
//   middleware/auth.ts → requireAuth
//     - req.cookies['mm_token'] → 取 JWT
//     - verifyToken(token) → 解密 → { sub:userId, ... }
//     - getUserById(payload.sub) → 查库确认用户还在
//     - req.user = user → 注入到请求对象
//   后面的路由就能用 req.user.id / req.user.tenantId
//
//   ③ 发消息
//   小王发消息 → chat.ts → req.user.id = 'uuid-xxx'（auth 中间件注入的）
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   注册/登录 → auth.ts 发 JWT cookie
//   每次请求 → middleware/auth.ts 验 JWT → req.user
//   所有需要登录的路由 → requireAuth 中间件保护
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - routes/auth.ts: registerUser/loginUser/signToken（注册登录）
//   - middleware/auth.ts: verifyToken/getUserById（验 JWT）
//
//   它调用：
//   - bcryptjs → hashSync/compareSync（密码哈希）
//   - jsonwebtoken → sign/verify（JWT 签发验证）
//   - db/index.js → 读写 users 表
//   - config/index.js → config.jwtSecret（JWT 密钥）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - import bcrypt from 'bcryptjs' → 导入第三方库
//   - jwt.sign / jwt.verify → 签发/验证 JWT
//   - crypto.randomUUID() → Node 内置 UUID 生成
//   - db.prepare().get() → SQL 查询一条结果
//   - as 断言 → 告诉 TS "get() 返回的是这个类型"
// ============================================================

import bcrypt from 'bcryptjs'                              // bcrypt：密码哈希库
import jwt from 'jsonwebtoken'                              // jsonwebtoken：签发和验证 JWT
import { config } from '../config/index.js'                 // 全局配置（读 JWT 密钥）
import { getDB } from '../db/index.js'                      // 数据库连接
import { randomUUID } from 'crypto'                          // Node 内置 UUID 生成器

// 【interface】鉴权后的用户信息（挂在 req.user 上）
// 文件路径：server/src/services/auth.ts
export interface AuthUser {
  id: string           // 用户 ID（UUID）
  tenantId: string     // 租户 ID（多租户占位）
  username: string     // 用户名
  displayName: string  // 显示名（可改）
}

// 【interface】JWT 负载 — JWT token 里存的信息
// 文件路径：server/src/services/auth.ts
export interface JWTPayload {
  sub: string      // subject：用户 ID（JWT 标准字段叫 sub）
  tenant: string   // 租户 ID
  username: string // 用户名
}

const TOKEN_TTL = '7d'             // token 有效期：7 天
const COOKIE_NAME = 'mm_token'     // cookie 名字

// 【函数】加密密码 — 明文 → bcrypt 哈希（单向，不可逆）
// 文件路径：server/src/services/auth.ts → hashPassword()
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 12)
  //                       ↑ 明文   ↑ cost：2^12=4096 轮（越大力越贵，12 是平衡点）
  //   hashSync 是同步版本（比异步简单，注册/登录这种低频操作同步无所谓）
}

// 【函数】验证密码 — 明文 vs 哈希，返回 true/false
// 文件路径：server/src/services/auth.ts → verifyPassword()
export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash)
  //     compareSync：比对明文和哈希，匹配返回 true
}

// 【函数】签发 JWT — 把用户信息打包成一个加密字符串
// 文件路径：server/src/services/auth.ts → signToken()
export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: TOKEN_TTL })
  //               ↑ 要打包的数据   ↑ 密钥（签名用）    ↑ 7 天后过期
}

// 【函数】验证 JWT — 解密并验证签名，返回 payload 或 null
// 文件路径：server/src/services/auth.ts → verifyToken()
export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as JWTPayload
    //     ↑ 验证签名 + 解出 payload   ↑ 密钥（必须和签发时一样）
  } catch {
    // 过期、签名不对、篡改 → 都算无效
    return null
  }
}

export const authCookieName = COOKIE_NAME

// 【函数】密码强度校验 — 不合格返回错误信息，合格返回 null
// 文件路径：server/src/services/auth.ts → validatePassword()
export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return '密码至少 8 位'
  if (!/[a-zA-Z]/.test(pw)) return '密码需包含字母'
  //   ↑ 正则：pw 里至少有一个字母
  if (!/\d/.test(pw)) return '密码需包含数字'
  //   ↑ 正则：pw 里至少有一个数字
  return null  // null = 合格
}

// 【函数】用户名格式校验 — 3-32 字符，允许字母数字下划线和中文
// 文件路径：server/src/services/auth.ts → validateUsername()
export function validateUsername(name: string): string | null {
  if (name.length < 3 || name.length > 32) return '用户名 3-32 字符'
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(name))
  //    ↑ ^ 行首，$ 行尾，\u4e00-\u9fa5 中文字符范围
    return '用户名仅允许字母数字下划线和中文'
  return null
}

// 【interface】注册输入
// 文件路径：server/src/services/auth.ts
export interface RegisterInput {
  username: string
  password: string
  displayName?: string  // ? 可选：不传就用 username
}

// 【函数】注册新用户
// 文件路径：server/src/services/auth.ts → registerUser()
export function registerUser(input: RegisterInput, tenantId = 'default'): AuthUser {
  const db = getDB()
  const username = input.username.trim()

  // ① 校验用户名格式
  const unErr = validateUsername(username)
  if (unErr) throw new Error(unErr)

  // ② 校验密码强度
  const pwErr = validatePassword(input.password)
  if (pwErr) throw new Error(pwErr)

  // ③ 检查用户名是否已存在（大小写不敏感）
  const exists = db.prepare(
    'SELECT 1 FROM users WHERE tenant_id = ? AND lower(username) = lower(?)'
    //                                        ↑ lower：转小写比较
  ).get(tenantId, username)
  if (exists) throw new Error('用户名已被占用')

  // ④ 生成 UUID → 加密密码 → 写入 DB
  const id = randomUUID()
  db.prepare(`
    INSERT INTO users (id, tenant_id, username, password_hash, display_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, tenantId, username, hashPassword(input.password), input.displayName || username)
  //    ↑ UUID       ↑ bcrypt 哈希，不存明文

  return { id, tenantId, username, displayName: input.displayName || username }
}

// 【函数】登录 — 查用户名、验密码，返回用户信息
// 文件路径：server/src/services/auth.ts → loginUser()
export function loginUser(username: string, password: string, tenantId = 'default'): AuthUser {
  const db = getDB()

  // ① 查用户（大小写不敏感）
  const row = db.prepare(`
    SELECT id, tenant_id, username, display_name, password_hash
    FROM users WHERE tenant_id = ? AND lower(username) = lower(?)
  `).get(tenantId, username.trim()) as {
    id: string; tenant_id: string; username: string
    display_name: string | null; password_hash: string
  } | undefined
  //   ↑ as 断言：告诉 TS "get() 返回的是这个类型"

  if (!row) throw new Error('用户名或密码错误')  // 不区分"用户不存在"和"密码错误"，防用户名枚举

  // ② 验密码
  if (!verifyPassword(password, row.password_hash)) throw new Error('用户名或密码错误')

  return { id: row.id, tenantId: row.tenant_id, username: row.username, displayName: row.display_name || row.username }
}

// 【函数】按用户 ID 查用户信息（鉴权中间件用）
// 文件路径：server/src/services/auth.ts → getUserById()
export function getUserById(userId: string): AuthUser | null {
  const db = getDB()
  const row = db.prepare(
    'SELECT id, tenant_id, username, display_name FROM users WHERE id = ?'
  ).get(userId) as { id: string; tenant_id: string; username: string; display_name: string | null } | undefined
  if (!row) return null
  return { id: row.id, tenantId: row.tenant_id, username: row.username, displayName: row.display_name || row.username }
}
