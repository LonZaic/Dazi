// ============================================================
// test.ts — 测试路由（触发 AI 派发测试 + 查询日志）
// 文件路径：server/src/routes/test.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  提供两个接口：                                             ║
// ║   - POST /api/test/run     → 触发 AI 派发测试              ║
// ║   - GET  /api/test/trace   → 查询运行日志（JSON）          ║
// ║   - GET  /api/test/report  → 下载最新 HTML 报告             ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

import { Router } from 'express'
import { trace } from '../services/traceLogger.js'
import { runAiDispatchTest } from '../scripts/aiDispatchTest.js'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(__dirname, '..', '..', 'reports')

export const testRouter = Router()

// ════════════════════════════════════════════════════════════
//  POST /run — 触发 AI 派发测试
// ════════════════════════════════════════════════════════════
testRouter.post('/run', async (req, res) => {
  try {
    trace.event('test.api.triggered', { by: req.user?.id || 'anonymous' })
    const report = await runAiDispatchTest()
    res.json({
      ok: true,
      summary: {
        durationMs: report.totalDurationMs,
        users: report.users.length,
        matches: report.matches.length,
        tokenSaving: report.tokenComparison.saving.percent + '%',
        reportUrl: '/api/test/report',
      },
      users: report.users.map(u => ({
        username: u.username,
        displayName: u.displayName,
        mbti: u.actualMbti,
        expectedMbti: u.expectedMbti,
        confidence: u.mbtiConfidence,
        chatRounds: u.chatRounds,
        tokens: u.tokenUsed,
      })),
      matches: report.matches,
      tokenComparison: report.tokenComparison,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════════
//  GET /trace — 查询运行日志
// ════════════════════════════════════════════════════════════
testRouter.get('/trace', (req, res) => {
  const kind = req.query.kind as string | undefined
  const userId = req.query.userId as string | undefined
  const since = req.query.since ? Number(req.query.since) : undefined

  const entries = trace.getEntries({
    kind: kind as any,
    userId,
    since,
  })

  res.json({
    count: entries.length,
    logFile: trace.getLogFile(),
    entries: entries.slice(-500),  // 最多返回最近 500 条
  })
})

// ════════════════════════════════════════════════════════════
//  GET /report — 下载最新 HTML 报告
// ════════════════════════════════════════════════════════════
testRouter.get('/report', (req, res) => {
  const reportPath = join(REPORT_DIR, 'latest-report.html')
  if (!existsSync(reportPath)) {
    res.status(404).json({ error: '尚无测试报告，请先 POST /api/test/run 触发测试' })
    return
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.sendFile(reportPath)
})
