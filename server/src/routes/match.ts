// ============================================================
// match.ts — 匹配路由（触发匹配 + 查看候选 + 生成破冰）
// 文件路径：server/src/routes/match.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  用户聊够了，点"开始匹配"，这组接口就启动。                ║
// ║   - POST /api/match/run：跑匹配引擎，返回最合拍的 5 个人    ║
// ║   - GET  /api/match/history：看历史匹配记录                 ║
// ║   - POST /api/match/icebreaker：为某匹配对象生成破冰话术    ║
// ║  前端拿到的是结构化对象（候选列表+因子+解释），不是字符串。  ║
// ╚══════════════════════════════════════════════════════════╝
//
// 【关键 TS 语法点】
//   - new MatchAgent() → 实例化 Agent
//   - agent.run(input, ctx) → 调用 Agent（返回 { ok, data } 或 { ok: false, error }）
//   - result.data! → 非空断言（ok=true 时 data 必有值）
//   - Math.round(x * 1000) / 1000 → 保留 3 位小数
// ============================================================

import { Router } from 'express'  // Express 路由
import { requireAuth } from '../middleware/auth.js'  // 鉴权中间件
import { MatchAgent, type MatchCandidate } from '../agents/matchAgent.js'  // 匹配 Agent
import { IceBreakerAgent } from '../agents/iceBreakerAgent.js'  // 破冰 Agent
import { getSession, transition } from '../core/orchestrator.js'  // 会话状态机
import { loadProfile } from '../agents/profileAgent.js'  // 加载画像
import { getDB } from '../db/index.js'  // 数据库连接
import { matchAdapter, iceBreakerAdapter } from '../integrations/agentMemoryAdapter.js'  // 四层记忆

// 文件路径：server/src/routes/match.ts → matchRouter
export const matchRouter = Router()  // 创建路由器
const matchAgent = new MatchAgent()          // 匹配 Agent 实例（全局单例）
const iceBreakerAgent = new IceBreakerAgent() // 破冰 Agent 实例

// POST /run — 触发匹配（MatchAgent 召回+排序）
/** 触发匹配（MatchAgent 召回+排序） */
matchRouter.post('/run', requireAuth, async (req, res) => {
  const ctx = getSession(req.user!.id, req.user!.tenantId)  // 拿会话上下文
  const profile = loadProfile(req.user!.id)                  // 加载当前用户画像

  // ① 画像不够 → 拒绝匹配（没画像没法匹配）
  if (!profile || profile.interests.length === 0) {
    res.status(400).json({ error: '画像还不够，先去聊几句再匹配' })
    return
  }

  // ② 状态机转移：→ MATCHING（正在匹配）
  transition(ctx, { type: 'match_requested' })

  // ③ 跑匹配 Agent（内部：向量召回 → 5 维排序 → 取 top5 → 存 DB）
  const result = await matchAgent.run({ limit: req.body?.limit }, ctx)
  if (!result.ok) {
    res.status(500).json({ error: result.error || '匹配失败' })
    return
  }

  // ④ 状态机转移：→ MATCH_DONE（匹配完成）
  transition(ctx, { type: 'match_done' })

  // ★ 写 Layer 3（匹配决策记忆）：下轮匹配去重 + 反馈迭代权重
  for (const c of result.data!.candidates) {
    try {
      matchAdapter.recordMatch(
        ctx.userId, c.userId, c.score,
        c.factors,                           // 维度得分
        (c.commonInterests || []).map(t => ({ tag: t, contribution: 1 })),
      )
    } catch { /* 记忆写入非关键 */ }
  }

  // ⑤ 返回候选列表给前端
  res.json({
    candidates: result.data!.candidates.map(toPublicCandidate),  // 转成前端格式
    totalCount: result.data!.totalCount,   // 总候选数（可能 > 5，只是返回了 top5）
    myProfileText: result.data!.myProfileText,  // 我的画像文本（前端可展示）
    state: ctx.state,  // 当前会话状态
  })
})

// GET /history — 历史匹配记录（最近 50 条）
/** 历史匹配记录 */
matchRouter.get('/history', requireAuth, (req, res) => {
  const db = getDB()
  // 查 matches 表：我匹配了谁、分数、因子、解释、破冰话术、状态
  const rows = db.prepare(`
    SELECT m.user_b, m.score, m.factors_json, m.explanation, m.icebreakers_json,
           m.state, m.created_at, u.display_name
    FROM matches m
    JOIN users u ON u.id = m.user_b      -- 关联用户表拿显示名
    WHERE m.tenant_id = ? AND m.user_a = ?
    ORDER BY m.id DESC LIMIT 50          -- 最近 50 条
  `).all(req.user!.tenantId, req.user!.id) as Array<{
    user_b: string; score: number; factors_json: string; explanation: string
    icebreakers_json: string | null; state: string; created_at: number; display_name: string | null
  }>

  res.json({
    history: rows.map(r => ({
      userId: r.user_b,                                    // 被匹配的用户 ID
      displayName: r.display_name || '匿名用户',            // 显示名
      score: r.score,                                      // 匹配分数（0-1）
      factors: JSON.parse(r.factors_json),                 // 5 维因子明细
      explanation: r.explanation,                          // LLM 生成的解释（为什么匹配）
      icebreakers: r.icebreakers_json ? JSON.parse(r.icebreakers_json) : null, // 破冰话术
      state: r.state,                                      // 状态：suggested/viewed/icebroken/rejected
      createdAt: r.created_at,                             // 匹配时间
    })),
  })
})

// POST /icebreaker — 为指定候选人生成破冰话术
/** 为指定候选人生成破冰话术 */
matchRouter.post('/icebreaker', requireAuth, async (req, res) => {
  const { targetUserId } = req.body || {}  // 目标用户 ID
  if (!targetUserId) {
    res.status(400).json({ error: '缺少目标用户' })
    return
  }

  const ctx = getSession(req.user!.id, req.user!.tenantId)
  const myProfile = loadProfile(req.user!.id)
  if (!myProfile) {
    res.status(400).json({ error: '你还没有画像' })
    return
  }

  // ① 取最近一次匹配该目标的记录（拿因子与共同兴趣）
  const db = getDB()
  const matchRow = db.prepare(`
    SELECT factors_json, score FROM matches
    WHERE tenant_id = ? AND user_a = ? AND user_b = ?
    ORDER BY id DESC LIMIT 1
  `).get(ctx.tenantId, ctx.userId, targetUserId) as { factors_json: string; score: number } | undefined

  if (!matchRow) {
    res.status(404).json({ error: '未找到匹配记录，请先重新匹配' })
    return
  }

  // ② 加载目标用户的画像（生成破冰需要知道对方的兴趣）
  const factors = JSON.parse(matchRow.factors_json)
  const targetProfile = await loadTargetProfile(targetUserId, ctx.tenantId)
  if (!targetProfile) {
    res.status(404).json({ error: '目标用户画像不存在' })
    return
  }

  // ③ 状态机转移 → ICEBREAKING
  transition(ctx, { type: 'icebreak_requested' })

  // ④ 跑破冰 Agent（LLM 生成/模板生成破冰话术）
  const result = await iceBreakerAgent.run({
    targetUserId,
    targetProfile,                                          // 对方画像
    myInterests: myProfile.interests.map(i => i.name),      // 我的兴趣列表
    commonInterests: targetProfile.interests.filter((i: string) =>
      myProfile.interests.some(mi => mi.name.toLowerCase() === i.toLowerCase())), // 共同兴趣
    matchScore: matchRow.score,                             // 匹配分数
  }, ctx)
  transition(ctx, { type: 'icebreak_done' })  // 状态转移 → ICEBROKEN

  if (!result.ok) {
    res.status(500).json({ error: result.error || '破冰生成失败' })
    return
  }

  // ★ 写 Layer 4（撮合交互记忆）：避免下轮破冰重复话题 + 优化策略
  try {
    for (const ib of result.data!.icebreakers) {
      iceBreakerAdapter.recordInteraction(
        ctx.userId, targetUserId, 'llm',
        ib,  // string 格式
        myProfile.interests.map(i => i.name),
        0,  // 效果待用户反馈
      )
    }
  } catch { /* 记忆写入非关键 */ }

  res.json({
    icebreakers: result.data!.icebreakers,  // 破冰话术数组
    source: result.data!.source,            // 来源：llm 或 template
    factors,                                // 匹配因子（前端展示"为什么推荐"）
  })
})

// 【工具函数】加载目标用户画像（生成破冰时需要对方的兴趣/风格）
// 文件路径：server/src/routes/match.ts → loadTargetProfile()
async function loadTargetProfile(userId: string, tenantId: string) {
  const db = getDB()
  const row = db.prepare(`
    SELECT p.profile_json, p.confidence, u.display_name
    FROM profiles p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? AND p.tenant_id = ?
  `).get(userId, tenantId) as { profile_json: string; confidence: number; display_name: string | null } | undefined
  if (!row) return null
  try {
    const p = JSON.parse(row.profile_json)  // 解析画像 JSON
    return {
      displayName: row.display_name || '匿名用户',
      confidence: row.confidence,
      interests: p.interests?.map((i: any) => i.name) || [],
      socialStyle: {
        energy: p.socialStyle?.energy || 'unknown',
        depth: p.socialStyle?.depth || 'unknown',
      },
      schedule: p.schedule || [],
      goal: p.goal || '',
    }
  } catch {
    return null  // 画像 JSON 损坏 → 返回 null
  }
}

// 【工具函数】把 MatchCandidate 转成前端格式（脱敏 + 格式化）
// 文件路径：server/src/routes/match.ts → toPublicCandidate()
function toPublicCandidate(c: MatchCandidate) {
  return {
    userId: c.userId,
    displayName: c.displayName,
    score: Math.round(c.score * 1000) / 1000,  // 保留 3 位小数（如 0.876）
    factors: c.factors,                          // 6 维因子明细（含 mbti）
    commonInterests: c.commonInterests,          // 共同兴趣
    explanation: c.explanation,                  // LLM 解释
    interests: c.snapshot.interests,             // 对方兴趣
    socialStyle: c.snapshot.socialStyle,         // 对方社交风格
    goal: c.snapshot.goal,                       // 对方目标
    schedule: c.snapshot.schedule,               // 对方活跃时段
    // MBTI 兼容度详情（搭子卡徽章 + 因子雷达图都从这里取数据）
    mbti: c.mbtiCompat ? {
      theirsType: c.mbtiCompat.theirsType,       // 对方 MBTI 类型（如 'ENFP'），搭子卡徽章用
      mineType: c.mbtiCompat.mineType,           // 我的 MBTI 类型（可选展示）
      score: c.mbtiCompat.score,                 // MBTI 兼容度 0-1
      reason: c.mbtiCompat.reason,               // 可解释文本
      mineConfidence: c.mbtiCompat.mineConfidence,
      theirsConfidence: c.mbtiCompat.theirsConfidence,
      detail: c.mbtiCompat.detail,               // 3 维子分（功能互补/维度平衡/主导和谐）
    } : null,
  }
}
