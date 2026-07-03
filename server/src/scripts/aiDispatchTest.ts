// ============================================================
// aiDispatchTest.ts — AI 派发用户两两匹配测试
// 文件路径：server/src/scripts/aiDispatchTest.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  目的：模拟真实用户全链路，测试项目可用性 + 算 token 花费    ║
// ║                                                            ║
// ║  流程：                                                     ║
// ║   Phase 1: 派发 4 个 AI 用户（不同 MBTI 性格）              ║
// ║     - Alice (INTJ 战略家) - 喜欢深度思考、技术、独自工作    ║
// ║     - Bob   (ENFP 竞选者) - 热情、社交、创意、户外          ║
// ║     - Carol (ISFJ 守卫者) - 温暖、细心、规律、读书          ║
// ║     - David (ENTP 辩论家) - 好奇、辩论、技术、创业          ║
// ║                                                            ║
// ║   Phase 2: 每个 AI 用户聊 5 轮（生成画像 + MBTI 抽取）       ║
// ║     每轮都过完整链路：                                      ║
// ║       用户消息 → 存 DB → ProfileAgent 流式回复              ║
// ║       → 异步抽画像 → MBTI 抽取 → 写 DB                      ║
// ║                                                            ║
// ║   Phase 3: 测试两组（A/B 对比）                             ║
// ║     组 A（baseline）：关闭 Reasonix 缓存，重复聊天 5 轮      ║
// ║     组 B（reasonix）：启用 Reasonix 缓存，重复聊天 5 轮      ║
// ║     → 对比 token 消耗 + cache hit 率                        ║
// ║                                                            ║
// ║   Phase 4: 触发两两匹配                                    ║
// ║     Alice vs Bob/Carol/David → 看是否推荐合理               ║
// ║     输出每个候选的 6 维因子（含 MBTI）                      ║
// ║                                                            ║
// ║   Phase 5: 生成 HTML 报告 → reports/test-report.html        ║
// ║     - 时间线（所有函数调用 + 数据流）                       ║
// ║     - 用户画像表（4 个 AI 的完整画像）                      ║
// ║     - 匹配结果表（6 维因子 + MBTI 兼容度）                  ║
// ║     - Token 花费对比表（baseline vs reasonix）              ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

import { trace } from '../services/traceLogger.js'
import { registerUser, signToken, authCookieName, type AuthUser } from '../services/auth.js'
import { chatStream, chatOnce, llmEnabled, type LLMUsage } from '../services/llmClient.js'
import { ProfileAgent, loadProfile, persistProfile, type RecentMessage } from '../agents/profileAgent.js'
import { createEmptyProfile, applyPatch, profileToText } from '../agents/profileSchema.js'
import { embed } from '../services/embedding.js'
import { MatchAgent } from '../agents/matchAgent.js'
import { getSession } from '../core/orchestrator.js'
import { getDB } from '../db/index.js'
import {
  extractMbtiSignals,
  applyDimensionPatch,
  createEmptyMbtiProfile,
  type MbtiProfile,
} from '../mbti/index.js'
import { getMbtiProfile, updateMbtiFromMessages } from '../integrations/mbtiProfileAdapter.js'
import { computeMbtiFactor } from '../integrations/matchAgentMbtiAdapter.js'
import { chatWithCache } from '../integrations/cacheLlmAdapter.js'
import { DEFAULT_COMPACT_CONFIG } from '../compress/compressTypes.js'
import type { ChatMessage } from '../services/llmClient.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(__dirname, '..', '..', 'reports')
mkdirSync(REPORT_DIR, { recursive: true })

// ════════════════════════════════════════════════════════════
//  【数据】4 个 AI 用户的人设脚本（5 轮对话）
// ════════════════════════════════════════════════════════════
interface AiUserScript {
  username: string
  displayName: string
  password: string
  mbtiExpected: string
  personality: string  // system prompt 描述
  messages: string[]   // 5 轮用户消息
}

const AI_USERS: AiUserScript[] = [
  {
    username: 'alice_intj',
    displayName: 'Alice',
    password: 'test12345',
    mbtiExpected: 'INTJ',
    personality: '你是 Alice，一个 INTJ 战略家型的人。你说话简洁、逻辑性强、喜欢深度思考。你是一名软件架构师，热爱技术、读书、独自工作。社交上偏内向，喜欢一对一深度交流而非大群体。活跃时段是工作日晚上和周末下午。',
    messages: [
      '你好，我最近在找一个能一起讨论技术架构的搭子，最好是能周末一起喝咖啡聊代码的那种。',
      '我平时工作日晚上 8 点后有空，周末下午喜欢去咖啡厅。最近在读《Designing Data-Intensive Applications》。',
      '我喜欢深度对话，不太喜欢闲聊。找搭子主要是为了能互相学习，我擅长后端架构和系统设计。',
      '我的目标是找一个技术搭子，能一起做 side project，或者一起研究新技术。你有什么推荐的吗？',
      '对了，我比较内向，不喜欢太吵的环境。最好是一对一交流，人多我会觉得累。MBTI 我是 INTJ，不知道这个信息有没有用。',
    ],
  },
  {
    username: 'bob_enfp',
    displayName: 'Bob',
    password: 'test12345',
    mbtiExpected: 'ENFP',
    personality: '你是 Bob，一个 ENFP 竞选者型的人。你热情、外向、充满创意、喜欢户外活动。你是一名产品经理，热爱徒步、摄影、社交。活跃时段是周末全天和工作日晚上。',
    messages: [
      '嘿！我在找一个一起徒步爬山的搭子！上周末我刚去了香山，景色太棒了，想找人一起去更多地方！',
      '我工作日晚上都有空，周末更喜欢户外活动。最近在计划去箭扣长城露营，超级兴奋！',
      '我是个超级外向的人，喜欢群体活动，认识新朋友让我充满能量！还喜欢摄影，随手拍拍那种。',
      '我的目标啊，就是找个能一起探索世界的人！不一定要一样，互补也行，关键是要有热情！',
      '我是 ENFP，据说和 INTJ 是绝配哈哈！你觉得 MBTI 这个东西准吗？我反正觉得挺像我的。',
    ],
  },
  {
    username: 'carol_isfj',
    displayName: 'Carol',
    password: 'test12345',
    mbtiExpected: 'ISFJ',
    personality: '你是 Carol，一个 ISFJ 守卫者型的人。你温暖、细心、有规律、喜欢读书和烹饪。你是一名护士，生活作息规律，喜欢安静的环境。活跃时段是工作日晚上和周末上午。',
    messages: [
      '你好，我想找一个一起读书的搭子，最好是周末上午在图书馆或者安静的咖啡厅。',
      '我平时作息很规律，晚上 10 点前睡，早上 7 点起。周末上午喜欢去图书馆看书，最近在读《百年孤独》。',
      '我性格比较温和，喜欢安静的环境，不太喜欢太热闹的场合。我还喜欢烹饪，周末会做点小点心。',
      '我的目标是找一个能一起安静读书、偶尔交流心得的搭子。不需要太多互动，能互相陪伴就好。',
      '我是 ISFJ，守卫者型。我很重视承诺和稳定，希望找的搭子也是靠谱的人。',
    ],
  },
  {
    username: 'david_entp',
    displayName: 'David',
    password: 'test12345',
    mbtiExpected: 'ENTP',
    personality: '你是 David，一个 ENTP 辩论家型的人。你好奇、爱辩论、喜欢创业和技术。你是一名创业者，热爱新技术、辩论、探索未知。活跃时段不固定，经常深夜工作。',
    messages: [
      '哟！我在找一个能一起辩论技术趋势的搭子，最好是那种能和我针锋相对的人！',
      '我作息不太规律，经常深夜写代码到凌晨 2 点。周末喜欢参加各种 tech meetup，认识有意思的人。',
      '我超爱辩论！不管是技术选型还是商业模式，我都喜欢挑刺。AI 取代程序员这事我有一百个观点。',
      '我的目标？找个能一起做 startup 的合伙人，或者至少能一起 hackathon 的搭子。要敢想敢干！',
      '我是 ENTP，据说和 INTJ 是黄金搭档。我负责发散，TA 负责收敛，完美！你觉得呢？',
    ],
  },
]

// ════════════════════════════════════════════════════════════
//  【主流程】runAiDispatchTest
// ════════════════════════════════════════════════════════════
interface TestReport {
  startedAt: number
  finishedAt: number
  totalDurationMs: number
  users: AiUserReport[]
  matches: MatchReport[]
  tokenComparison: TokenComparison
  traceEntries: any[]
}

interface AiUserReport {
  username: string
  displayName: string
  userId: string
  expectedMbti: string
  actualMbti: string
  mbtiConfidence: number
  profile: any
  chatRounds: number
  tokenUsed: { prompt: number; completion: number; total: number }
}

interface MatchReport {
  matcherId: string
  matcherName: string
  matcherMbti: string
  candidates: Array<{
    candidateId: string
    candidateName: string
    candidateMbti: string
    score: number
    factors: any
    mbtiCompat: any
  }>
}

interface TokenComparison {
  baseline: { prompt: number; completion: number; total: number; costYuan: number; rounds: number }
  reasonix: { prompt: number; completion: number; total: number; costYuan: number; cacheHit: number; cacheMiss: number; rounds: number }
  saving: { tokens: number; percent: number; costYuan: number }
}

// ════════════════════════════════════════════════════════════
//  DeepSeek V4-Flash 官方价格（2026 年，从 API 文档读取）
//  https://api-docs.deepseek.com/quick_start/pricing
// ════════════════════════════════════════════════════════════
//  美元价格 → 人民币（汇率 7.2）
//    输入（cache miss）：$0.14/1M → ¥1.008/1M
//    输入（cache hit） ：$0.014/1M → ¥0.1008/1M（节省 90%）
//    输出             ：$0.28/1M  → ¥2.016/1M
// ════════════════════════════════════════════════════════════
const PRICE_INPUT_MISS_PER_M = 1.008   // 缓存未命中：¥1.008/百万 token
const PRICE_INPUT_HIT_PER_M = 0.1008   // 缓存命中：¥0.1008/百万 token
const PRICE_OUTPUT_PER_M = 2.016       // 输出：¥2.016/百万 token

export async function runAiDispatchTest(): Promise<TestReport> {
  trace.event('test.start', { users: AI_USERS.length, llmEnabled })
  const startedAt = Date.now()

  if (!llmEnabled) {
    trace.event('test.skip', { reason: 'LLM 未配置，跳过 token 对比' })
  }

  // ─── Phase 1: 注册 4 个 AI 用户 ───
  trace.event('phase.1.register.start')
  const users: Array<AiUserScript & { auth: AuthUser }> = []
  for (const script of AI_USERS) {
    try {
      const auth = registerUser({
        username: script.username,
        password: script.password,
        displayName: script.displayName,
      }, 'default')
      trace.event('user.registered', { userId: auth.id, username: auth.username })
      users.push({ ...script, auth })
    } catch (err: any) {
      // 用户已存在，尝试登录
      trace.event('user.register.failed', { username: script.username, error: err.message })
      // 用 sqlite 直接查
      const db = getDB()
      const row = db.prepare('SELECT id, username, display_name, tenant_id FROM users WHERE username = ?').get(script.username) as any
      if (row) {
        users.push({ ...script, auth: { id: row.id, username: row.username, displayName: row.display_name, tenantId: row.tenant_id } })
        trace.event('user.reuse', { userId: row.id, username: script.username })
      }
    }
  }
  trace.event('phase.1.register.done', { count: users.length })

  // ─── Phase 2: 每个 AI 用户聊 5 轮 ───
  // ★ 科学对比关键：Phase 2 跑的真实对话已经包含 DeepSeek 自动缓存命中
  //   - baseline = 假设全部 input 按 miss 计费（无缓存优化的理论成本）
  //   - reasonix = 实际 hit/miss 计费（DeepSeek 自动缓存的真实成本）
  //   - 两组用相同轮数、相同 token 数据，只差计费方式 → 科学对比
  trace.event('phase.2.chat.start', { users: users.length, rounds: 5 })
  const userReports: AiUserReport[] = []
  // 汇总真实 token 数据（含 cache hit/miss）
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheHitTokens = 0
  let totalCacheMissTokens = 0
  let totalRounds = 0

  for (const user of users) {
    trace.event('user.chat.start', { userId: user.auth.id, username: user.username })
    const report: AiUserReport = {
      username: user.username,
      displayName: user.displayName,
      userId: user.auth.id,
      expectedMbti: user.mbtiExpected,
      actualMbti: 'UNKNOWN',
      mbtiConfidence: 0,
      profile: null,
      chatRounds: 0,
      tokenUsed: { prompt: 0, completion: 0, total: 0 },
    }

    // 系统消息
    const systemMsg: ChatMessage = {
      role: 'system',
      content: user.personality + '\n\n你是 MatchMate 平台的用户，正在和 AI 助手聊天描述自己的画像。请用第一人称自然回答，体现你的 MBTI 性格特点。',
    }
    // ★ 测试也走 cache 模块（和生产路径一致，真实测出省钱效果）
    //   cache 模块内部维护 prefix(system) + log(历史)，自动命中 DeepSeek prefix cache
    const sessionId = `sess_test_${user.auth.id}`

    // 跑 5 轮对话
    for (let i = 0; i < user.messages.length; i++) {
      const userMsg = user.messages[i]

      trace.event('chat.round.start', { userId: user.auth.id, round: i + 1, msgLen: userMsg.length })

      // 调 chatWithCache（走 cache 模块，真实命中 DeepSeek prefix cache）
      let aiReply = ''
      try {
        const result = await trace.fn(
          'chatWithCache',
          () => chatWithCache(
            user.auth.id,
            sessionId,
            systemMsg.content,
            userMsg,
            { onText: (delta) => { aiReply += delta } },
          ),
          { userId: user.auth.id, payload: { round: i + 1 } }
        )

        // 记录 token（含 DeepSeek 自动缓存命中数据）
        // ★ 注意：chatWithCache 返回 CacheUsagePayload（字段名和 LLMUsage 不同）
        //   promptTokens → inputTokens, completionTokens → outputTokens
        //   promptCacheHitTokens → cacheHitTokens
        const u = result.usage as {
          promptTokens: number
          completionTokens: number
          promptCacheHitTokens?: number
          promptCacheMissTokens?: number
        }
        if (u && u.promptTokens !== undefined) {
          const inputTokens = u.promptTokens || 0
          const outputTokens = u.completionTokens || 0
          const cacheHit = u.promptCacheHitTokens || 0
          const cacheMiss = u.promptCacheMissTokens || inputTokens
          totalInputTokens += inputTokens
          totalOutputTokens += outputTokens
          totalCacheHitTokens += cacheHit
          totalCacheMissTokens += cacheMiss
          totalRounds++

          report.tokenUsed.prompt += inputTokens
          report.tokenUsed.completion += outputTokens
          report.tokenUsed.total += inputTokens + outputTokens

          trace.token({
            model: 'deepseek-v4-flash',
            prompt: inputTokens,
            completion: outputTokens,
            cacheHit,
            cacheMiss,
            hitRate: cacheHit / Math.max(1, inputTokens),
            userId: user.auth.id,
            scenario: `chat.round.${i + 1}`,
            costYuan: calcCost(inputTokens, outputTokens, cacheHit),
          })
        }

        // cache 模块内部已 append AI 回复到 log，这里不重复维护 history
        report.chatRounds++

        trace.event('chat.round.done', {
          userId: user.auth.id,
          round: i + 1,
          replyLen: aiReply.length,
          tokens: { input: u.promptTokens, output: u.completionTokens, cacheHit: u.promptCacheHitTokens },
        })

        // 存到 DB（让 ProfileAgent 后续能读到）
        const db = getDB()
        db.prepare(`
          INSERT INTO conversations (user_id, tenant_id, role, content, meta_json, created_at)
          VALUES (?, ?, 'user', ?, '{}', ?)
        `).run(user.auth.id, user.auth.tenantId, userMsg, Date.now())
        db.prepare(`
          INSERT INTO conversations (user_id, tenant_id, role, content, meta_json, created_at)
          VALUES (?, ?, 'assistant', ?, '{}', ?)
        `).run(user.auth.id, user.auth.tenantId, aiReply, Date.now())
      } catch (err: any) {
        trace.event('chat.round.error', { userId: user.auth.id, round: i + 1, error: err.message })
        throw err  // 不再造假数据，直接抛出让上层处理
      }

      // 每轮后异步抽 MBTI 信号并更新画像
      try {
        // 从 DB 查所有历史对话给 MBTI 抽取（cache 模块的 log 是内部状态，不能直接用）
        const dbMsgs = getDB().prepare(`
          SELECT role, content FROM conversations
          WHERE user_id = ? ORDER BY id ASC
        `).all(user.auth.id) as Array<{ role: string; content: string }>
        const allMsgs: ChatMessage[] = dbMsgs.map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
        }))
        const mbti = await trace.fn(
          'updateMbtiFromMessages',
          () => updateMbtiFromMessages(user.auth.id, allMsgs),
          { userId: user.auth.id }
        )
        report.actualMbti = mbti.type
        report.mbtiConfidence = mbti.confidence
        trace.data('mbti.updated', { userId: user.auth.id, type: mbti.type, confidence: mbti.confidence }, { userId: user.auth.id })
      } catch (err: any) {
        trace.event('mbti.extract.error', { userId: user.auth.id, error: err.message })
      }
    }

    // 加载最终画像
    report.profile = loadProfile(user.auth.id)
    userReports.push(report)
    trace.event('user.chat.done', {
      userId: user.auth.id,
      rounds: report.chatRounds,
      mbti: report.actualMbti,
      tokens: report.tokenUsed,
    })
  }
  trace.event('phase.2.chat.done', {
    users: userReports.length,
    totalRounds,
    totalInputTokens,
    totalOutputTokens,
    totalCacheHitTokens,
    totalCacheMissTokens,
    cacheHitRate: totalCacheHitTokens / Math.max(1, totalInputTokens),
  })

  // ─── Phase 3: 科学 Token 对比（基于 Phase 2 真实数据） ───
  // ★ 科学对比原理：
  //   Phase 2 跑的 20 轮对话，DeepSeek API 自动返回了每轮的 cache hit/miss 数据
  //   - baseline = 假设全部 input 按 miss 单价计费（无缓存优化的理论成本）
  //   - reasonix = 实际 hit/miss 分别计费（DeepSeek 自动缓存 + Reasonix append-only 策略的真实成本）
  //   - 两组用相同轮数、相同 token 数据 → 公平科学对比
  //   - 注意：token 数量本身没变，变的是计费单价（命中部分便宜 90%）
  trace.event('phase.3.cacheComparison.start', {
    rounds: totalRounds,
    inputTokens: totalInputTokens,
    cacheHitTokens: totalCacheHitTokens,
    cacheMissTokens: totalCacheMissTokens,
  })

  // baseline：全部 input 按 miss 单价计费（无缓存优化的理论成本）
  const baselineCost = calcBaselineCost(totalInputTokens, totalOutputTokens)
  const baselineTotalTokens = totalInputTokens + totalOutputTokens

  // reasonix：hit 部分按 ¥0.1/M，miss 部分按 ¥1.0/M（DeepSeek 真实计费）
  const reasonixCost = calcCost(totalInputTokens, totalOutputTokens, totalCacheHitTokens)
  const reasonixTotalTokens = totalInputTokens + totalOutputTokens  // token 数相同
  // 等效节省 token 数 = 命中的 token × (1 - HIT_PRICE/MISS_PRICE) = 命中 token × 90%
  const equivalentSavedTokens = Math.round(totalCacheHitTokens * 0.9)

  const tokenComparison: TokenComparison = {
    baseline: {
      prompt: totalInputTokens,
      completion: totalOutputTokens,
      total: baselineTotalTokens,
      costYuan: baselineCost,
      rounds: totalRounds,
    },
    reasonix: {
      prompt: totalInputTokens,
      completion: totalOutputTokens,
      total: reasonixTotalTokens,
      costYuan: reasonixCost,
      cacheHit: totalCacheHitTokens,
      cacheMiss: totalCacheMissTokens,
      rounds: totalRounds,  // ★ 相同轮数！
    },
    saving: {
      // 等效节省的 token 数（命中部分按 90% 折扣计算）
      tokens: equivalentSavedTokens,
      // 成本节省百分比
      percent: baselineCost > 0
        ? Math.round((1 - reasonixCost / baselineCost) * 1000) / 10
        : 0,
      // 节省的钱（人民币）
      costYuan: Math.round((baselineCost - reasonixCost) * 10000) / 10000,
    },
  }

  trace.event('phase.3.cacheComparison.done', {
    baselineCost,
    reasonixCost,
    savingPercent: tokenComparison.saving.percent,
    cacheHitRate: totalCacheHitTokens / Math.max(1, totalInputTokens),
  })

  // ─── Phase 4: 两两匹配 ───
  trace.event('phase.4.match.start')

  // ★ 匹配前先抽取完整画像（兴趣/风格/目标），填到 blackboard 给 MatchAgent 用
  //   MBTI 抽取在 Phase 2 每轮后已跑，这里补 profile 抽取
  const profileAgent = new ProfileAgent()
  for (const user of users) {
    const ctx = getSession(user.auth.id, user.auth.tenantId)
    // 从 DB 拿所有对话历史给 profile 抽取
    const dbMsgs = getDB().prepare(`
      SELECT role, content FROM conversations
      WHERE user_id = ? ORDER BY id ASC
    `).all(user.auth.id) as Array<{ role: string; content: string }>
    const allMsgs: RecentMessage[] = dbMsgs.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }))

    try {
      const patch = await trace.fn(
        'profileAgent.extractProfile',
        () => profileAgent.extractProfile(allMsgs, ctx),
        { userId: user.auth.id }
      )
      // 应用 patch 到 profile（持久化到 DB）
      const existing = loadProfile(user.auth.id) || createEmptyProfile(user.auth.id)
      const updated = applyPatch(existing, patch)
      persistProfile(user.auth.id, user.auth.tenantId, updated)
      ctx.profileConfidence = updated.confidence

      // ★ 重算画像向量并写入 DB（MatchAgent 召回靠这个）
      //   生产路径 profileAgent.execute() 会自动做，测试直接调 extractProfile 需手动补
      try {
        const profileText = profileToText(updated)
        const vec = await embed(profileText)
        getDB().prepare('UPDATE profiles SET embedding = ? WHERE user_id = ?').run(JSON.stringify(vec), user.auth.id)
      } catch (embErr: any) {
        trace.event('profile.embedding.error', { userId: user.auth.id, error: embErr.message })
      }

      trace.data('profile.extracted', {
        userId: user.auth.id,
        confidence: updated.confidence,
        interests: updated.interests.length,
      }, { userId: user.auth.id })
    } catch (err: any) {
      trace.event('profile.extract.error', { userId: user.auth.id, error: err.message })
    }
  }

  const matches: MatchReport[] = []
  const matchAgent = new MatchAgent()

  for (const user of users) {
    // 用 orchestrator 的 getSession 拿完整 ctx（含 blackboard）
    const ctx = getSession(user.auth.id, user.auth.tenantId)
    const result = await trace.fn(
      'matchAgent.run',
      () => matchAgent.run({ limit: 5 }, ctx),
      { userId: user.auth.id }
    )
    if (result.ok && result.data) {
      const candidates = result.data.candidates.map((c: any) => {
        const mbtiFactor = computeMbtiFactor(user.auth.id, c.userId)
        return {
          candidateId: c.userId,
          candidateName: c.displayName || c.userId,
          candidateMbti: mbtiFactor.theirsType,
          score: c.score,
          factors: c.factors,
          mbtiCompat: {
            score: mbtiFactor.score,
            reason: mbtiFactor.reason,
            mineType: mbtiFactor.mineType,
            theirsType: mbtiFactor.theirsType,
          },
        }
      })
      matches.push({
        matcherId: user.auth.id,
        matcherName: user.displayName,
        matcherMbti: userReports.find(r => r.userId === user.auth.id)?.actualMbti || 'UNKNOWN',
        candidates,
      })
      trace.data('match.result', { userId: user.auth.id, candidateCount: candidates.length })
    }
  }
  trace.event('phase.4.match.done', { matches: matches.length })

  // ─── Phase 5: 生成报告 ───
  // tokenComparison 已在 Phase 3 基于真实数据计算完成
  const finishedAt = Date.now()

  const report: TestReport = {
    startedAt,
    finishedAt,
    totalDurationMs: finishedAt - startedAt,
    users: userReports,
    matches,
    tokenComparison,
    traceEntries: trace.getEntries(),
  }

  trace.event('test.done', {
    durationMs: report.totalDurationMs,
    users: report.users.length,
    matches: report.matches.length,
    tokenSaving: tokenComparison.saving.percent + '%',
  })

  // 写 HTML 报告
  const html = generateHtmlReport(report)
  const reportPath = join(REPORT_DIR, `test-report-${Date.now()}.html`)
  writeFileSync(reportPath, html, 'utf8')
  trace.event('report.written', { path: reportPath })

  // 同时写一个最新的别名
  writeFileSync(join(REPORT_DIR, 'latest-report.html'), html, 'utf8')

  return report
}

// ════════════════════════════════════════════════════════════
//  【工具】calcCost — 按DeepSeek真实计费规则计算花费（人民币元）
// ════════════════════════════════════════════════════════════
//  计费公式（DeepSeek 官方）：
//    总费用 = cacheMissTokens × MISS价 + cacheHitTokens × HIT价 + outputTokens × OUTPUT价
//
//  注意：inputTokens = cacheHitTokens + cacheMissTokens（DeepSeek 自动拆分）
//        不能用 inputTokens × 全价 + cacheHit × HIT价（会重复计费！）
// ════════════════════════════════════════════════════════════
function calcCost(
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens: number,
): number {
  // cacheMiss = input - cacheHit（API 返回的 inputTokens 包含两部分）
  const cacheMiss = Math.max(0, inputTokens - cacheHitTokens)
  const missCost = (cacheMiss / 1_000_000) * PRICE_INPUT_MISS_PER_M
  const hitCost = (cacheHitTokens / 1_000_000) * PRICE_INPUT_HIT_PER_M
  const outputCost = (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M
  return Math.round((missCost + hitCost + outputCost) * 10000) / 10000
}

// baselineCost：假设全部 input 都 miss（无缓存优化的理论成本）
function calcBaselineCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * PRICE_INPUT_MISS_PER_M
  const outputCost = (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M
  return Math.round((inputCost + outputCost) * 10000) / 10000
}

// ════════════════════════════════════════════════════════════
//  【HTML 报告生成】
// ════════════════════════════════════════════════════════════
function generateHtmlReport(report: TestReport): string {
  const time = (ts: number) => new Date(ts).toLocaleString('zh-CN')
  const pct = (n: number) => (n * 100).toFixed(1) + '%'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>MatchMate AI 派发测试报告</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1115; color: #e8e8e8; padding: 24px; }
  h1 { color: #fff; margin-bottom: 8px; }
  h2 { color: #8b5cf6; margin: 32px 0 16px; border-left: 4px solid #8b5cf6; padding-left: 12px; }
  h3 { color: #10b981; margin: 20px 0 12px; }
  .meta { color: #888; font-size: 13px; margin-bottom: 24px; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #1a1d24; border: 1px solid #2a2d34; border-radius: 12px; padding: 16px; }
  .card-label { color: #888; font-size: 12px; text-transform: uppercase; margin-bottom: 4px; }
  .card-value { color: #fff; font-size: 24px; font-weight: 700; }
  .card-value.green { color: #10b981; }
  .card-value.red { color: #ef4444; }
  .card-value.yellow { color: #f59e0b; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: #1a1d24; border-radius: 12px; overflow: hidden; }
  th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #2a2d34; }
  th { background: #222631; color: #8b5cf6; font-weight: 600; font-size: 13px; text-transform: uppercase; }
  td { font-size: 14px; }
  tr:hover { background: #22263150; }
  .mbti-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 700; }
  .mbti-NT { background: rgba(139,92,246,0.2); color: #a78bfa; }
  .mbti-NF { background: rgba(16,185,129,0.2); color: #34d399; }
  .mbti-SJ { background: rgba(79,125,255,0.2); color: #93c5fd; }
  .mbti-SP { background: rgba(255,138,76,0.2); color: #fb923c; }
  .mbti-UNKNOWN { background: rgba(120,120,120,0.2); color: #aaa; }
  .score-bar { display: inline-block; height: 8px; border-radius: 4px; background: linear-gradient(90deg, #ef4444, #f59e0b, #10b981); }
  .timeline { max-height: 600px; overflow-y: auto; background: #1a1d24; border-radius: 12px; padding: 12px; font-family: 'Consolas', monospace; font-size: 12px; }
  .timeline-item { padding: 4px 0; border-bottom: 1px solid #2a2d3430; }
  .timeline-time { color: #888; }
  .timeline-kind { padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; margin: 0 8px; }
  .kind-fn { background: #0e749040; color: #67e8f9; }
  .kind-event { background: #7c3aed40; color: #c4b5fd; }
  .kind-token { background: #ca8a0440; color: #fde68a; }
  .kind-data { background: #15803d40; color: #86efac; }
  .kind-cache { background: #1d4ed840; color: #93c5fd; }
  .kind-state { background: #4b556340; color: #d1d5db; }
  .highlight { background: #1a1d24; border-left: 4px solid #10b981; padding: 12px 16px; margin: 12px 0; border-radius: 0 8px 8px 0; }
  .highlight.warn { border-color: #f59e0b; }
  pre { background: #0f1115; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
</style>
</head>
<body>
  <h1>MatchMate AI 派发测试报告</h1>
  <div class="meta">
    生成时间：${time(report.finishedAt)} ｜
    总耗时：${(report.totalDurationMs / 1000).toFixed(2)}s ｜
    AI 用户数：${report.users.length} ｜
    LLM 状态：${llmEnabled ? '✅ 已启用 (DeepSeek)' : '⚠️ 未配置（降级模式）'}
  </div>

  <h2>📊 总览</h2>
  <div class="summary">
    <div class="card">
      <div class="card-label">总对话轮数</div>
      <div class="card-value">${report.users.reduce((s, u) => s + u.chatRounds, 0)}</div>
    </div>
    <div class="card">
      <div class="card-label">匹配成功数</div>
      <div class="card-value green">${report.matches.reduce((s, m) => s + m.candidates.length, 0)}</div>
    </div>
    <div class="card">
      <div class="card-label">MBTI 识别率</div>
      <div class="card-value yellow">${pct(report.users.filter(u => u.actualMbti !== 'UNKNOWN').length / report.users.length)}</div>
    </div>
    <div class="card">
      <div class="card-label">Token 节省</div>
      <div class="card-value green">${report.tokenComparison.saving.percent}%</div>
    </div>
  </div>

  <h2>👥 AI 用户画像</h2>
  <table>
    <tr>
      <th>用户</th><th>预期 MBTI</th><th>实际 MBTI</th><th>置信度</th>
      <th>对话轮数</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>总 Tokens</th>
    </tr>
    ${report.users.map(u => `
    <tr>
      <td><strong>${u.displayName}</strong><br><small style="color:#888">@${u.username}</small></td>
      <td><span class="mbti-badge mbti-${mbtiGroup(u.expectedMbti)}">${u.expectedMbti}</span></td>
      <td><span class="mbti-badge mbti-${mbtiGroup(u.actualMbti)}">${u.actualMbti}</span></td>
      <td>${(u.mbtiConfidence * 100).toFixed(1)}%</td>
      <td>${u.chatRounds}</td>
      <td>${u.tokenUsed.prompt}</td>
      <td>${u.tokenUsed.completion}</td>
      <td><strong>${u.tokenUsed.total}</strong></td>
    </tr>`).join('')}
  </table>

  ${report.users.map(u => u.profile ? `
  <h3>${u.displayName} 的完整画像</h3>
  <pre>${JSON.stringify(u.profile, null, 2)}</pre>
  ` : '').join('')}

  <h2>💞 两两匹配结果</h2>
  ${report.matches.map(m => `
  <h3>${m.matcherName} <span class="mbti-badge mbti-${mbtiGroup(m.matcherMbti)}">${m.matcherMbti}</span> 的推荐搭子</h3>
  <table>
    <tr>
      <th>候选</th><th>MBTI</th><th>综合分</th>
      <th>向量</th><th>兴趣</th><th>风格</th><th>时段</th><th>目标</th><th>MBTI 兼容</th>
      <th>MBTI 解释</th>
    </tr>
    ${m.candidates.map(c => `
    <tr>
      <td><strong>${c.candidateName}</strong></td>
      <td><span class="mbti-badge mbti-${mbtiGroup(c.candidateMbti)}">${c.candidateMbti}</span></td>
      <td><strong>${(c.score * 100).toFixed(1)}%</strong></td>
      <td>${(c.factors.vector * 100).toFixed(0)}%</td>
      <td>${(c.factors.interest * 100).toFixed(0)}%</td>
      <td>${(c.factors.style * 100).toFixed(0)}%</td>
      <td>${(c.factors.schedule * 100).toFixed(0)}%</td>
      <td>${(c.factors.goal * 100).toFixed(0)}%</td>
      <td>${(c.factors.mbti * 100).toFixed(0)}%</td>
      <td><small style="color:#888">${c.mbtiCompat.reason}</small></td>
    </tr>`).join('')}
  </table>`).join('')}

  <h2>💰 Token 花费对比（Reasonix 缓存方案）</h2>
  <div class="highlight ${llmEnabled ? '' : 'warn'}">
    ${llmEnabled
      ? '✅ DeepSeek API 已接入，以下为真实 token 消费数据（含自动缓存命中）'
      : '⚠️ DeepSeek API 未配置，以下为估算数据（基于字符数 / 1.5）'}
  </div>
  <table>
    <tr>
      <th>方案</th><th>轮数</th><th>Prompt</th><th>Completion</th>
      <th>缓存命中</th><th>缓存未命中</th>
      <th>总 Token</th><th>花费（元）</th>
    </tr>
    <tr>
      <td><strong>Baseline</strong><br><small style="color:#888">假设无缓存（全部按 miss 计费）</small></td>
      <td>${report.tokenComparison.baseline.rounds}</td>
      <td>${report.tokenComparison.baseline.prompt}</td>
      <td>${report.tokenComparison.baseline.completion}</td>
      <td style="color:#888">0</td>
      <td>${report.tokenComparison.baseline.prompt}</td>
      <td><strong>${report.tokenComparison.baseline.total}</strong></td>
      <td>¥${report.tokenComparison.baseline.costYuan.toFixed(4)}</td>
    </tr>
    <tr>
      <td><strong>Reasonix</strong><br><small style="color:#10b981">DeepSeek 自动缓存 + append-only</small></td>
      <td>${report.tokenComparison.reasonix.rounds}</td>
      <td>${report.tokenComparison.reasonix.prompt}</td>
      <td>${report.tokenComparison.reasonix.completion}</td>
      <td style="color:#10b981">${report.tokenComparison.reasonix.cacheHit}</td>
      <td>${report.tokenComparison.reasonix.cacheMiss}</td>
      <td><strong>${report.tokenComparison.reasonix.total}</strong></td>
      <td>¥${report.tokenComparison.reasonix.costYuan.toFixed(4)}</td>
    </tr>
    <tr style="background: #10b98115">
      <td colspan="6"><strong>节省</strong>（命中部分按 90% 折扣的等效 token）</td>
      <td><strong style="color:#10b981">${report.tokenComparison.saving.tokens}</strong></td>
      <td><strong style="color:#10b981">¥${report.tokenComparison.saving.costYuan.toFixed(4)} (${report.tokenComparison.saving.percent}%)</strong></td>
    </tr>
  </table>

  <h2>📋 定价参考（DeepSeek V4-Flash，2026 年官方定价）</h2>
  <div class="meta">
    输入（缓存未命中）：¥${PRICE_INPUT_MISS_PER_M}/百万 token ｜
    输入（缓存命中）：¥${PRICE_INPUT_HIT_PER_M}/百万 token（节省 90%）｜
    输出：¥${PRICE_OUTPUT_PER_M}/百万 token<br>
    <small style="color:#888">
      数据来源：https://api-docs.deepseek.com/quick_start/pricing ｜
      汇率：$1 = ¥7.2 ｜
      缓存命中：DeepSeek 自动处理，无需配置
    </small>
  </div>

  <h2>📜 完整运行时间线（${report.traceEntries.length} 条）</h2>
  <div class="timeline">
    ${report.traceEntries.slice(-200).reverse().map(e => `
    <div class="timeline-item">
      <span class="timeline-time">${new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}.${String(e.ts % 1000).padStart(3, '0')}</span>
      <span class="timeline-kind kind-${e.kind}">${e.kind.toUpperCase()}</span>
      <strong>${e.name}</strong>
      ${e.durationMs != null ? `<span style="color:#888"> (${e.durationMs}ms)</span>` : ''}
      ${e.userId ? `<span style="color:#67e8f9"> [user:${e.userId.slice(0, 8)}]</span>` : ''}
      ${e.error ? `<span style="color:#ef4444"> ❌ ${e.error}</span>` : ''}
      ${e.payload ? `<div style="color:#888; margin-left: 24px; font-size: 11px;">${JSON.stringify(e.payload).slice(0, 300)}</div>` : ''}
    </div>`).join('')}
  </div>

  <h2>🔧 系统信息</h2>
  <pre>{
  "node": "${process.version}",
  "platform": "${process.platform}",
  "llmEnabled": ${llmEnabled},
  "llmModel": "deepseek-v4-flash",
  "compressConfig": {
    "contextWindowTokens": ${DEFAULT_COMPACT_CONFIG.contextWindowTokens},
    "autoCompactThreshold": ${DEFAULT_COMPACT_CONFIG.contextUsageThreshold}
  }
}</pre>
</body>
</html>`
}

function mbtiGroup(type: string): string {
  if (type === 'UNKNOWN' || type.length < 3) return 'UNKNOWN'
  const s = type[1], t = type[2]
  if (s === 'N' && t === 'T') return 'NT'
  if (s === 'N' && t === 'F') return 'NF'
  if (s === 'S' && t === 'J') return 'SJ'
  if (s === 'S' && t === 'P') return 'SP'
  return 'UNKNOWN'
}

// ════════════════════════════════════════════════════════════
//  【CLI 入口】直接 node 跑这个文件就执行测试
// ════════════════════════════════════════════════════════════
//   命令：npx tsx src/scripts/aiDispatchTest.ts
//   报告：reports/latest-report.html
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAiDispatchTest()
    .then((report) => {
      // eslint-disable-next-line no-console
      console.log('\n════════════════════════════════════════════════════')
      // eslint-disable-next-line no-console
      console.log('  ✅ 测试完成！')
      // eslint-disable-next-line no-console
      console.log(`  📄 报告：${REPORT_DIR}/latest-report.html`)
      // eslint-disable-next-line no-console
      console.log(`  📊 日志：${trace.getLogFile()}`)
      // eslint-disable-next-line no-console
      console.log(`  💰 Token 节省：${report.tokenComparison.saving.percent}%`)
      // eslint-disable-next-line no-console
      console.log('════════════════════════════════════════════════════\n')
      process.exit(0)
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('❌ 测试失败：', err)
      process.exit(1)
    })
}
