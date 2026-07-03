// ============================================================
// index.ts — 服务入口（Express 应用启动文件）
// 文件路径：server/src/index.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这是整个后端的"启动文件"。                                  ║
// ║  npm run dev 跑的就是这个文件。                              ║
// ║  它干的事：建 Express app → 挂中间件 → 挂路由 →            ║
// ║           监听端口 → 等请求来。                             ║
// ║                                                            ║
// ║  中间件顺序很重要（从上到下依次执行）：                      ║
// ║   CORS → JSON解析 → Cookie解析 → 安全头 → 路由 → 404 → 错误 ║
// ╚══════════════════════════════════════════════════════════╝
//
// 【关键 TS 语法点】
//   - express() → 创建 Express 应用
//   - app.use(path, router) → 把路由挂到指定路径前缀
//   - process.on('SIGINT', ...) → 监听进程信号（Ctrl+C）
//   - server.close() → 优雅关闭（等现有请求处理完）
// ============================================================

import express from 'express'                 // Express 框架
import cors from 'cors'                        // CORS 中间件（跨域）
import cookieParser from 'cookie-parser'       // Cookie 解析中间件
import { config } from './config/index.js'     // 全局配置
import { getDB, closeDB } from './db/index.js' // 数据库连接
import { initSchema } from './db/schema.js'    // 建表
import { authRouter } from './routes/auth.js'  // 认证路由
import { chatRouter } from './routes/chat.js'  // 聊天路由
import { profileRouter } from './routes/profile.js' // 画像路由
import { matchRouter } from './routes/match.js'     // 匹配路由
import { privacyRouter } from './routes/privacy.js' // 隐私路由
import { healthRouter } from './routes/health.js'   // 健康检查路由
import { dmRouter } from './routes/dm.js'           // 私信路由
import { testRouter } from './routes/test.js'       // 测试路由（AI 派发 + 日志 + 报告）
// ▼▼▼ 【增强系统新增】（可选，未配 REDIS_URL 时自动降级到内存模式）▼▼▼
import { initEnhancedSystem } from './integrations/index.js'
import { saveMemoryToRedis, stopPeriodicSave } from './redis/index.js'
// ▲▲▲ 增强系统：Redis 持久化 + 4 层记忆恢复 + MBTI/Cache/Compress 模块 ▲▲▲

// 启动时初始化数据库（建表，幂等：已存在不报错）
initSchema()
// 确保连接热身（提前打开 DB，避免第一个请求慢）
getDB().prepare('SELECT 1').get()

// ▼▼▼ 【增强系统新增】启动 Redis + 恢复记忆（异步，不阻塞主流程）▼▼▼
initEnhancedSystem().catch(err => {
  console.warn('[启动] 增强系统初始化失败（降级到基础模式）：', err?.message ?? err)
})
// ▲▲▲ 即使 Redis 没装/没配，主服务也能正常跑 ▲▲▲

// 文件路径：server/src/index.ts → app
const app = express()        // 创建 Express 应用
const PORT = config.port     // 端口号（默认 8787）

// ─── 安全中间件 ───
// CORS：允许前端跨域访问（前端 5173 → 后端 8787）
app.use(cors({
  origin: config.webOrigin,    // 只允许前端地址跨域（白名单）
  credentials: true,           // 允许带 cookie（JWT 在 cookie 里）
  methods: ['GET', 'POST', 'DELETE', 'PATCH'], // 允许的 HTTP 方法
}))

// JSON 解析：把 req.body 从字符串变成 JS 对象（限 256kb 防大 payload 攻击）
app.use(express.json({ limit: '256kb' }))
// URL 编码解析（表单提交用，这里 extended:false 用简单解析）
app.use(express.urlencoded({ extended: false, limit: '256kb' }))
// Cookie 解析：把 req.headers.cookie 解析到 req.cookies 对象
app.use(cookieParser())

// 安全响应头（轻量版，不引 helmet 库）
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')           // 防 MIME 类型嗅探
  res.setHeader('X-Frame-Options', 'DENY')                      // 防点击劫持（禁止被 iframe 嵌入）
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin') // 控制 Referer 泄露
  res.setHeader('X-XSS-Protection', '1; mode=block')           // 启用浏览器 XSS 过滤
  next()
})

// ─── 路由挂载（路径前缀 + 路由器）───
app.use('/api', healthRouter)         // /api/health, /api/info, /api/stats
app.use('/api/auth', authRouter)      // /api/auth/register, /api/auth/login ...
app.use('/api/chat', chatRouter)      // /api/chat/messages, /api/chat/sessions ...
app.use('/api/profile', profileRouter) // /api/profile, /api/profile/history
app.use('/api/match', matchRouter)    // /api/match/run, /api/match/history ...
app.use('/api/privacy', privacyRouter) // /api/privacy/export, /api/privacy/account
app.use('/api/dm', dmRouter)          // /api/dm/rooms ...
app.use('/api/test', testRouter)      // /api/test/run, /api/test/trace, /api/test/report

// ─── 404 处理（所有未匹配的路由走到这）───
app.use((_req, res) => {
  res.status(404).json({ error: '接口不存在' })
})

// ─── 全局错误处理（任何路由抛错都走到这）───
// Express 错误中间件：必须有 4 个参数（err, req, res, next）
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[unhandled]', err)           // 后端日志记录（排查用）
  res.status(500).json({ error: '服务器内部错误' })  // 前端只看到通用错误（不泄露堆栈）
})

// 启动 HTTP 服务器，监听端口
const server = app.listen(PORT, () => {
  console.log(`\n  MatchMate 服务已启动`)
  console.log(`  → http://localhost:${PORT}`)
  console.log(`  → LLM: ${config.llm.enabled ? '已启用 (' + config.llm.model + ')' : '未启用（降级规则模式，匹配照常可用）'}`)
  console.log(`  → 嵌入: ${config.embed.enabled ? 'API' : '本地'}\n`)
})

// ─── 优雅关闭（Ctrl+C 或 kill 命令时触发）───
// 文件路径：server/src/index.ts → shutdown()
async function shutdown(sig: string) {
  console.log(`\n收到 ${sig}，正在关闭...`)

  // ① 保存 4 层记忆到 Redis（重启不丢）
  stopPeriodicSave()
  await saveMemoryToRedis().catch(() => {})

  // ② 关闭 HTTP 服务器 + 数据库
  server.close(() => {
    closeDB()
    console.log('已关闭。')
    process.exit(0)
  })
  // 5 秒后强制退出（防止某些请求卡住不结束）
  setTimeout(() => process.exit(1), 5000).unref()
}

// 监听进程信号
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
// 兜底：未捕获的异常（防进程崩溃）
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e))
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e))

// 文件路径：server/src/index.ts → app
export { app }  // 导出 app（测试用）
