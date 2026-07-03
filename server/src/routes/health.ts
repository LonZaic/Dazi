// ============================================================
// health.ts — 健康检查 + 系统状态（不含敏感信息）
// 文件路径：server/src/routes/health.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这组接口给运维/前端"探活"用。                              ║
// ║   - /health：服务还活着吗？→ {"ok": true}                    ║
// ║   - /info：有哪些能力？（LLM 开没开、嵌入模式、限流多少）    ║
// ║   - /stats：有多少用户/画像/匹配记录？                      ║
// ║  注意：不返回任何敏感信息（Key、密码、私聊内容）             ║
// ╚══════════════════════════════════════════════════════════╝
//
// 【关键 TS 语法点】
//   - Router() → Express 路由器，挂载到 /api
//   - db.prepare().get() → SQL 查一条
//   - as { c: number } → 类型断言：告诉 TS 返回值结构
// ============================================================

import { Router } from 'express'                    // Express 路由
import { getDB } from '../db/index.js'              // 数据库连接
import { llmEnabled } from '../services/llmClient.js' // LLM 是否启用
import { config } from '../config/index.js'         // 全局配置

// 文件路径：server/src/routes/health.ts → healthRouter
export const healthRouter = Router()  // 创建路由器，在 index.ts 里挂到 /api

// GET /health — 探活接口（运维监控用，不需登录）
healthRouter.get('/health', (_req, res) => {
  // _req：下划线前缀表示"不用这个参数"（TS/ESLint 约定）
  res.json({ ok: true, service: 'matchmate', version: '1.0.0-beta' })
  //   返回服务名+版本，运维据此判断"活着+是哪个版本"
})

// GET /info — 能力信息（前端据此显示"AI 模式/降级模式"）
healthRouter.get('/info', (_req, res) => {
  // 不泄露内部配置（Key/密码），只返回能力信息
  res.json({
    llmEnabled,                                        // LLM 是否启用（true=智能模式，false=降级模式）
    embedMode: config.embed.enabled ? 'api' : 'local', // 嵌入模式：api=远端高质量，local=本地哈希
    matchWeights: config.match.weights,                // 匹配 5 维权重（前端可展示"我们怎么算的"）
    rateLimitPerHour: config.rateLimitPerHour,         // 每小时限流多少条
  })
})

// GET /stats — 统计数据（前端首页/管理后台展示用）
healthRouter.get('/stats', (_req, res) => {
  const db = getDB()
  // COUNT(*) as c → 把计数结果取个别名叫 c，方便 TS 取值
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c
  //                                                                    ↑ as 断言：告诉 TS "get() 返回 { c: number }"
  const profileCount = (db.prepare('SELECT COUNT(*) as c FROM profiles WHERE confidence > 0').get() as { c: number }).c
  //                    ↑ 只统计有画像的（confidence > 0 说明聊过天抽过画像）
  const matchCount = (db.prepare('SELECT COUNT(*) as c FROM matches').get() as { c: number }).c
  res.json({ users: userCount, profiles: profileCount, matches: matchCount })
})
