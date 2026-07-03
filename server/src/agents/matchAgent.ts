// ============================================================
// matchAgent.ts — 匹配决策 Agent（链路核心 #2）
// 文件路径：server/src/agents/matchAgent.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个 Agent 是"红娘"——输入"我的画像"，输出"5 个最合拍的      ║
// ║  候选搭子"。每个候选带：综合分 + 5 维因子 + 解释文本。       ║
// ║                                                            ║
// ║  整个过程不调 LLM！纯计算。原因：                           ║
// ║  1. 快：50ms 内出结果（LLM 要 2-5 秒）                     ║
// ║  2. 稳：不依赖网络，不会因 API 故障挂掉                     ║
// ║  3. 可解释：每个因子分数透明，用户问"为啥推 TA" 能答         ║
// ║  4. 省钱：不花 token                                        ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王点"开始匹配"，MatchAgent 干了啥 ▼▼▼
//
//   小王聊了几轮，画像置信度 0.72（≥0.65 触发 PROFILE_READY）
//   小王点"开始匹配"按钮
//        │
//        ▼
//   POST /match（routes/match.ts）
//        │
//        ▼
//   matchAgent.run({ limit: 5 }, ctx)
//        │
//        ▼
//   execute() 6 步：
//   ① loadProfile('小王')
//      → 从 DB 读小王画像 = { interests:[跑步(0.8), 爬山(0.9)], socialStyle:{energy:'introvert'}, ... }
//      → 没画像/没兴趣 → 直接返回空（没法匹配）
//
//   ② profileToText(画像)
//      → "兴趣: 跑步 爬山 社交能量: introvert 活跃时段: weekend 目标: 周末爬山搭子"
//
//   ③ embed(text)  ← 调 embedding 模型
//      → 1536 维浮点向量（画像的"指纹"）
//
//   ④ recallByVector(myVec, tenantId, excludeUserId='小王', topK=20)
//      ← 在向量库（profiles.embedding 字段）找余弦相似度最高的 20 个候选
//      → [ {userId:'小李', profile:..., score:0.85}, {userId:'小张', ...}, ... ]
//      场景：库里 1000 个用户，向量相似度 top 20 → 候选池
//
//   ⑤ 对每个候选算 5 维因子 + 加权综合分：
//      小李的 5 维因子：
//        vector:   0.85  ← 向量相似度（步骤 4 算好的）
//        interest: 0.66  ← Jaccard（共同兴趣/较小集合 = 2/3）
//        style:    0.60  ← 都是 introvert + depth 相同
//        schedule: 1.00  ← 都周末活跃
//        goal:     0.90  ← 都想找爬山搭子
//      综合分 = 0.35*0.85 + 0.25*0.66 + 0.20*0.60 + 0.10*1.00 + 0.10*0.90
//             = 0.298 + 0.165 + 0.12 + 0.10 + 0.09 = 0.773
//
//   ⑥ 排序 + 取前 5 + 持久化：
//      candidates.sort((a,b) => b.score - a.score)  ← 按综合分降序
//      top = candidates.slice(0, 5)  ← 取前 5
//      persistMatches(...)  ← 存到 matches 表
//      blackboard.write('latest_matches', top)  ← 贴黑板便条给 IceBreaker
//
//   返回给前端 → 用户看到 5 个候选，每个带"为什么推荐 TA"
//
// ════════════════════════════════════════════════════════════
//  【匹配两阶段】（业界标准做法）
// ════════════════════════════════════════════════════════════
//   阶段 1 — 召回（粗筛）：
//     向量余弦相似度 top 20（快速缩小范围）
//     为什么不用规则全量筛？1000 用户 * 5 维规则 = 5000 次计算，慢
//     向量检索用 ANN 索引，毫秒级
//
//   阶段 2 — 排序（精排）：
//     5 维因子加权打分，取前 5（精确排序）
//     为什么不再用向量？向量是"整体相似度"，丢失细节
//     规则维度可以解释"为啥推 TA"
//
// ════════════════════════════════════════════════════════════
//  【5 维因子】
// ════════════════════════════════════════════════════════════
//   vector   = 向量相似度（画像"指纹"有多像，权重 0.35 最大）
//   interest = 兴趣重合度（共同爱好多不多，Jaccard 算法，权重 0.25）
//   style    = 社交风格匹配度（内向/外向、浅聊/深聊，权重 0.20）
//   schedule = 时段重合度（周末党 vs 工作日党，权重 0.10）
//   goal     = 目标互补度（都想找爬山搭子？，权重 0.10）
//
//   权重总和 = 1.0
//   权重在 config/index.ts，可调
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - db.transaction → 事务批量操作（全成功或全回滚）
//   - Set → 集合（快速查"有没有"，比数组快）
//   - clamp01 → 夹在 0-1 之间
//   - as 断言 → 告诉 TS "我知道这是什么类型"
// ============================================================

import { BaseAgent, type AgentContext } from './baseAgent.js'
import { recallByVector, type ProfileSnapshot } from '../db/vectorStore.js'
import type { Profile } from './profileSchema.js'
import { profileToText } from './profileSchema.js'
import { embed } from '../services/embedding.js'
import { matchAdapter } from '../integrations/agentMemoryAdapter.js'
import { getDB } from '../db/index.js'
import { config } from '../config/index.js'
import { addStep, startSpan, endSpan } from '../core/tracer.js'
import { computeMbtiFactor, type MbtiCompatFactor } from '../integrations/matchAgentMbtiAdapter.js'

// 【interface】匹配候选 — 一个推荐搭子的完整信息
// 文件路径：server/src/agents/matchAgent.ts
export interface MatchCandidate {
  userId: string               // 候选用户 ID
  displayName: string          // 候选显示名
  score: number                // 综合分 0-1（越高越合拍）
  factors: MatchFactors        // 各维度因子（前端画雷达图用）
  commonInterests: string[]    // 共同兴趣列表
  explanation: string          // 可解释文本（"为什么推荐 TA"）
  snapshot: ProfileSnapshot    // 画像快照（兴趣/风格/目标摘要）
  mbtiCompat?: MbtiCompatFactor  // MBTI 兼容度详情（含对方类型/昵称，搭子卡徽章用）
}

// 【interface】6 维匹配因子 — 从 6 个角度打分
// 文件路径：server/src/agents/matchAgent.ts
export interface MatchFactors {
  vector: number       // 向量相似度 0-1（画像"指纹"像不像）
  interest: number     // 兴趣重合 0-1（共同爱好多不多）
  style: number        // 社交风格匹配 0-1（内向 vs 外向等）
  schedule: number     // 时段重合 0-1（都在周末活跃？）
  goal: number         // 目标互补 0-1（都想找同类型搭子？）
  mbti: number         // MBTI 兼容度 0-1（思维方式互补，第 6 维）
}

// 【interface】匹配输入
// 文件路径：server/src/agents/matchAgent.ts
export interface MatchAgentInput {
  limit?: number  // 返回几个候选（? 可选，不传用 config.match.finalN，默认 5）
}

// 【interface】匹配输出
// 文件路径：server/src/agents/matchAgent.ts
export interface MatchAgentOutput {
  candidates: MatchCandidate[]  // 候选列表
  totalCount: number            // 总共筛出了多少个（含落选的）
  myProfileText: string         // 我的画像文本（embedding 用的原文）
}

// 【类】匹配 Agent
// 文件路径：server/src/agents/matchAgent.ts → MatchAgent
export class MatchAgent extends BaseAgent<MatchAgentInput, MatchAgentOutput> {
  readonly agentId = 'match-agent'
  readonly description = '向量召回 + 规则排序，输出可解释匹配候选'

  // 【核心方法】执行匹配（6 步）
  protected async execute(
    input: MatchAgentInput, 
    ctx: AgentContext
  ): Promise<MatchAgentOutput> {
    // 开始追踪
    const span = startSpan('match-agent', { userId: ctx.userId })

    // ① 从黑板读画像（ProfileAgent 异步写好的最新版本）
    const entry = ctx.blackboard.read('latest_profile')
    const myProfile = entry?.value as Profile | undefined
    if (!myProfile || myProfile.interests.length === 0) {
      // 没画像 → 没法匹配，返回空列表
      endSpan({ result: 'no_profile' })
      return { candidates: [], totalCount: 0, myProfileText: '' }
    }
    const myText = profileToText(myProfile)  // 画像 → 自然语言文本
    addStep('info', { event: 'profile_loaded', interests: myProfile.interests.length })

    // ② 我的画像文本 → 1536 维向量（通过 embedding 模型）
    const myVec = await embed(myText)
    addStep('extract', { event: 'embedded', dim: myVec.length })

    // ③ 向量召回 topK（用余弦相似度在向量库里排，取前 topK 个）
    //    排除我自己、同 tenant，config.match.topK 默认 20
    const recalled = recallByVector(myVec, ctx.tenantId, ctx.userId, config.match.topK)
    addStep('recall', { event: 'recall_done', count: recalled.length })
    if (recalled.length === 0) {
      endSpan({ result: 'no_candidates' })
      return { candidates: [], totalCount: 0, myProfileText: myText }
    }

    // ④ 多因子排序：对每个召回的候选算 6 维因子，加权综合分
    const candidates = recalled.map(r => {
      // 算 MBTI 兼容度（第 6 维，从 mbtiProfileAdapter 拿双方 MBTI 画像）
      const mbtiCompat = computeMbtiFactor(ctx.userId, r.userId)
      // 算 6 维因子分数（含 mbti）
      const factors = computeFactors(myProfile, r.profile, r.score, mbtiCompat.score)
      // 算加权综合分（权重在 config.match.weights）
      const score = weightedScore(factors)
      // 算共同兴趣
      const common = commonInterests(myProfile, r.profile)
      // 组装候选对象
      return {
        userId: r.userId,
        displayName: r.profile.displayName,
        score,                                  // 综合分
        factors,                                // 6 维因子（前端画雷达图）
        commonInterests: common,
        explanation: buildExplanation(r.profile, factors, common, myProfile, mbtiCompat),  // 可解释文本
        snapshot: r.profile,                    // 画像快照
        mbtiCompat,                             // MBTI 兼容度详情（搭子卡徽章用）
      }
    })

    // ⑤ 按综合分降序排列（分数高的在前）
    candidates.sort((a, b) => b.score - a.score)  // b-a 降序
    const limit = input.limit ?? config.match.finalN  // ?? 空值合并：limit 没传就用默认 5
    const top = candidates.slice(0, limit)  // 取前 N 个

    // ⑥ 写黑板（IceBreakerAgent 后续读到匹配结果）
    ctx.blackboard.write(this.agentId, 'latest_matches', top, 'match_result')

    // ⑦ 持久化匹配记录到 matches 表（事务批量写）
    persistMatches(ctx.tenantId, ctx.userId, top)

    // ⑧ ★ 写匹配决策记忆（Layer 3）：避免下次重复推荐同一批人
    try {
      for (const c of top) {
        matchAdapter.recordMatch(
          ctx.userId,
          c.userId,
          c.score,
          c.factors,
          c.commonInterests.map(tag => ({ tag, contribution: 0.5 })),
        )
      }
    } catch {
      // 记忆写入失败不致命
    }

    addStep('rank', { event: 'ranked', returned: top.length, total: candidates.length })
    endSpan({ result: 'ok', returned: top.length, total: candidates.length })

    return { candidates: top, totalCount: candidates.length, myProfileText: myText }
  }
}

// ─── 多因子计算函数 ───

// 【函数】计算 6 维匹配因子
// 文件路径：server/src/agents/matchAgent.ts → computeFactors()
function computeFactors(
  my: { interests: any[]; socialStyle: any; schedule: string[]; goal: string },
  theirs: ProfileSnapshot,
  vectorScore: number,      // 向量库里算好的余弦相似度
  mbtiScore: number,        // MBTI 兼容度（computeMbtiFactor 算好的）
): MatchFactors {
  return {
    vector: clamp01(vectorScore),  // 直接取预计算的向量相似度
    interest: interestOverlap(
      my.interests.map((i: any) => i.name),  // 我的所有兴趣名字
      theirs.interests                         // 对方的兴趣列表
    ),
    style: styleMatch(my.socialStyle, theirs.socialStyle),
    schedule: scheduleOverlap(my.schedule, theirs.schedule),
    goal: goalComplement(my.goal, theirs.goal),
    mbti: clamp01(mbtiScore),  // 第 6 维：MBTI 兼容度
  }
}

// 【函数】加权综合分 — 6 维因子 * 各自权重，加起来
// 文件路径：server/src/agents/matchAgent.ts → weightedScore()
function weightedScore(f: MatchFactors): number {
  const w = config.match.weights  // 权重在 config/index.ts 里，默认:
  //   { vector: 0.35, interest: 0.20, style: 0.15, schedule: 0.10, goal: 0.05, mbti: 0.15 }
  return clamp01(
    w.vector   * f.vector   +   // 向量相似度 × 0.35（权重最大）
    w.interest * f.interest +   // 兴趣重合 × 0.20
    w.style    * f.style    +   // 风格匹配 × 0.15
    w.schedule * f.schedule +   // 时段重合 × 0.10
    w.goal     * f.goal     +   // 目标互补 × 0.05
    w.mbti     * f.mbti        // MBTI 兼容 × 0.15（第 6 维）
  )
}

// 【函数】兴趣重合度 — 用 Jaccard 风格算法
// 文件路径：server/src/agents/matchAgent.ts → interestOverlap()
function interestOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0  // 任何一方没兴趣 → 重合度 0

  // Set：集合，用 has() 快速查"有没有"，比数组 includes 快
  const setB = new Set(b.map(s => s.toLowerCase()))  // 对方兴趣转小写集合
  // 数一下：我的兴趣里有多少个在对方集合里
  const overlap = a.filter(x => setB.has(x.toLowerCase())).length

  // 重合度 = 共同兴趣数 / 较小集合的大小（类似 Jaccard）
  return overlap / Math.min(a.length, b.length)
}

// 【函数】社交风格匹配度
// 文件路径：server/src/agents/matchAgent.ts → styleMatch()
function styleMatch(
  a: { energy: string; depth: string },   // 我的风格
  b: { energy: string; depth: string }    // 对方的风格
): number {
  let s = 0

  // energy（外向/内向/混合）匹配：
  //   相同 → +0.6（最合拍）
  //   有 ambivert（混合型）→ +0.5（混合型跟谁都还行）
  //   有一方 unknown → +0.3（不知道就给中间分）
  //   对立（introvert vs extrovert）→ +0.2（互补也有价值）
  if (a.energy === b.energy && a.energy !== 'unknown')
    s += 0.6
  else if (a.energy === 'unknown' || b.energy === 'unknown')
    s += 0.3
  else if (a.energy === 'ambivert' || b.energy === 'ambivert')
    s += 0.5
  else
    s += 0.2

  // depth（浅社交/深交流）匹配：
  //   相同 → +0.4
  //   有一方 unknown → +0.2
  //   不同 → +0.15
  if (a.depth === b.depth && a.depth !== 'unknown')
    s += 0.4
  else if (a.depth === 'unknown' || b.depth === 'unknown')
    s += 0.2
  else
    s += 0.15

  return clamp01(s)  // 夹在 0-1 之间
}

// 【函数】时段重合度
// 文件路径：server/src/agents/matchAgent.ts → scheduleOverlap()
function scheduleOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0.3  // 不知道时段 → 给个中间分（不扣死）
  const setB = new Set(b)  // 对方时段集合
  const overlap = a.filter(x => setB.has(x)).length  // 共同时段数
  return overlap / Math.max(a.length, b.length)  // 重合度 = 共同数 / 较大集合
}

// 【函数】目标互补度 — 找的字眼重叠越多越合拍
// 文件路径：server/src/agents/matchAgent.ts → goalComplement()
function goalComplement(a: string, b: string): number {
  if (!a || !b) return 0.3  // 不知道目标 → 给中间分

  // 把目标文本拆成词（中文字符、英文数字）
  const wa = new Set(a.toLowerCase().match(/[\u4e00-\u9fa5a-z0-9]+/g) || [])
  //             ↑ 正则匹配：中文字符范围 \u4e00-\u9fa5 或 英文数字 a-z0-9
  const wb = b.toLowerCase().match(/[\u4e00-\u9fa5a-z0-9]+/g) || []

  let overlap = 0
  for (const w of wb) {
    if (wa.has(w)) overlap++  // 词在双方目标里都出现 → 重叠 +1
  }

  return clamp01(0.3 + overlap * 0.3)  // 基础分 0.3 + 重叠加分
}

// 【函数】找共同兴趣 — 返回双方都有的兴趣名字列表
// 文件路径：server/src/agents/matchAgent.ts → commonInterests()
function commonInterests(
  my: { interests: any[] },
  theirs: ProfileSnapshot
): string[] {
  const myNames = new Set(my.interests.map((i: any) => i.name.toLowerCase()))
  return theirs.interests.filter(i => myNames.has(i.toLowerCase()))
  //                         ↑ filter：只保留双方都有的
}

// 【函数】生成可解释文本（不调 LLM，纯模板拼接保证稳定）
// 文件路径：server/src/agents/matchAgent.ts → buildExplanation()
function buildExplanation(
  theirs: ProfileSnapshot,  // 对方画像
  f: MatchFactors,          // 6 维因子
  common: string[],         // 共同兴趣
  my: { interests: any[] }, // 我的画像（只取兴趣）
  mbtiCompat?: MbtiCompatFactor,  // MBTI 兼容度详情（可选，未传则不提 MBTI）
): string {
  const parts: string[] = []

  // 有共同兴趣 → 提一嘴
  if (common.length > 0) {
    parts.push(`你们都对${common.slice(0, 3).join('、')}感兴趣`)
    //                       ↑ slice(0,3)：最多列 3 个兴趣
  }
  // 向量相似度高 → 画像像
  if (f.vector > 0.6) parts.push('整体画像高度相似')
  else if (f.vector > 0.4) parts.push('画像有一定相似度')
  // 风格合拍
  if (f.style > 0.7) parts.push('社交风格很合拍')
  // 时段重合
  if (f.schedule > 0.5) parts.push('活跃时段重合')
  // MBTI 合拍（第 6 维，新增）
  if (mbtiCompat && mbtiCompat.theirsType !== 'UNKNOWN' && f.mbti > 0.7) {
    parts.push(`MBTI ${mbtiCompat.theirsType}（${mbtiCompat.reason.split('，')[0]}）`)
  } else if (mbtiCompat && mbtiCompat.theirsType !== 'UNKNOWN' && f.mbti > 0.5) {
    parts.push(`TA 是 ${mbtiCompat.theirsType}，思维方式可互补`)
  }
  // 有目标
  if (theirs.goal) parts.push(`TA的目标是"${theirs.goal}"`)

  // 啥也没有 → 给个兜底
  if (parts.length === 0) return '系统基于整体相似度推荐，建议聊聊看是否合拍。'

  return parts.join('，') + '。'
  //     ↑ join('，')：用中文逗号连起来
}

// 【函数】持久化匹配记录到 DB（事务批量写）
// 文件路径：server/src/agents/matchAgent.ts → persistMatches()
function persistMatches(
  tenantId: string, userA: string, candidates: MatchCandidate[]
): void {
  const db = getDB()
  // prepare：预编译 SQL 语句（多次执行只编译一次，快）
  const stmt = db.prepare(`
    INSERT INTO matches (tenant_id, user_a, user_b, score, factors_json, explanation, state)
    VALUES (?, ?, ?, ?, ?, ?, 'suggested')
    --     ↑ 占位符 ? 按顺序填
  `)
  // transaction：事务 — 所有 INSERT 要么全成功，要么全回滚
  const tx = db.transaction((items: MatchCandidate[]) => {
    for (const c of items) {
      stmt.run(
        tenantId, 
        userA,                        // 谁发起的匹配
        c.userId,                     // 匹配到了谁
        c.score,                      // 综合分
        JSON.stringify(c.factors),    // 因子 JSON（5 维分数）
        c.explanation                 // 可解释文本
      )
    }
  })
  tx(candidates)  // 执行事务
}

// 【工具函数】把数字夹在 0-1 之间
// 文件路径：server/src/agents/matchAgent.ts → clamp01()
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
  //      ↑ 不小于 0      ↑ 不大于 1
}
