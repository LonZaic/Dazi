// ============================================================
// profileAgent.ts — 画像采集 Agent（链路核心 #1）
// 文件路径：server/src/agents/profileAgent.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个 Agent 是"用户画像采集员"——通过自然聊天，不动声色地     ║
// ║  把用户的兴趣/社交风格/找搭子目标挖出来。                    ║
// ║                                                            ║
// ║  核心创新：不让用户填表！                                   ║
// ║  传统 App 一上来扔 50 个表单字段，用户跑路。                ║
// ║  本系统用 AI 边聊边抽，用户感觉在闲聊，AI 在后台挖画像。     ║
// ║                                                            ║
// ║  双职责：                                                   ║
// ║  1. streamReply()：流式生成"AI 回复"（前端秒看到打字效果）  ║
// ║  2. execute()：异步抽取"画像 patch"（后台跑，不阻塞回复）   ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王发一句话，ProfileAgent 干了啥 ▼▼▼
//
//   小王在聊天框发"我最近开始跑步了"
//        │
//        ▼
//   POST /messages（routes/chat.ts）
//        │
//        ├──→ ① profileAgent.streamReply(...)   ← 同步流式回复
//        │     - 拼 system prompt（含画像+对话原则）
//        │     - 调 chatStream 真流式调 LLM
//        │     - 每个 token 通过 SSE 推给前端
//        │     - 用户秒看到"听起来挺棒！晨跑还是夜跑？"
//        │
//        └──→ ② profileAgent.run(...)  ← 异步后台执行
//              - execute() 干 5 件事：
//                a. extractProfile()  调 LLM 抽 patch
//                   → { interests:[{name:'跑步', confidence:0.8, evidence:'我最近开始跑步了'}] }
//                b. loadProfile()     从 DB 读旧画像
//                c. applyPatch()      增量合并 → 新画像
//                d. persistProfile()  存回 DB（profiles 表）
//                   persistPatch()    存变更记录（profile_patches 表）
//                e. embed()           算画像向量（MatchAgent 召回用）
//                   updateProfileEmbedding()
//                f. blackboard.write('latest_profile', ...)  贴黑板便条
//
//   两个任务并行，用户感觉不到延迟。
//
// ════════════════════════════════════════════════════════════
//  【双模式设计】（保证可跑 + 省钱）
// ════════════════════════════════════════════════════════════
//   - LLM 模式：有 API Key 时，用 DeepSeek 抽+聊（智能但花钱）
//   - 降级模式：无 Key/出错时，用关键词+模板（免费但傻）
//
//   降级为什么重要？
//   - API Key 可能没钱了/被墙了/超时
//   - 系统要保证"任何时候都能用"
//   - MatchAgent 不依赖 LLM，所以即使降级也能匹配
//   - 用户体验：从"智能朋友"降级到"机械客服"，但能用
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   用户发消息 → chat.ts 路由
//                    ├→ ProfileAgent.streamReply()（流式回复，前端秒看）
//                    └→ ProfileAgent.run()（异步抽画像，后台跑）
//
//   画像是 MatchAgent 的输入：没画像就没法向量匹配
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - chat.ts: profileAgent.streamReply()（流式回复，前端秒看）
//   - chat.ts: profileAgent.run()（异步抽画像，后台跑）
//   - matchAgent.ts: loadProfile()（读已存的画像）
//
//   它调用：
//   - baseAgent.js → BaseAgent（继承，复用 run 骨架）
//   - profileSchema.js → applyPatch/computeConfidence（合并画像）
//   - llmClient.js → chatStream/chatOnce（调 DeepSeek）
//   - embedding.js → embed（算画像向量）
//   - structuredOutput.js → JSON 抽取+校验（防 LLM 乱输出）
//   - db/index.js → 读写 profiles/profile_patches 表
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - extends：继承基类
//   - override/implements：实现抽象方法
//   - type import：只导入类型（编译后不存在）
//   - as 断言：告诉编译器"我知道这是什么类型"
// ============================================================
import { BaseAgent, type AgentContext, type AgentResult } from './baseAgent.js'
import {
  type Profile, type ProfilePatch, applyPatch, computeConfidence, createEmptyProfile, profileToText,
} from './profileSchema.js'
import { chatStream, chatOnce, llmEnabled, type ChatMessage, type LLMUsage } from '../services/llmClient.js'
import { chatWithCache } from '../integrations/cacheLlmAdapter.js'
import { profileAdapter } from '../integrations/agentMemoryAdapter.js'
import { embed } from '../services/embedding.js'
import { getDB } from '../db/index.js'
import { config } from '../config/index.js'
import { extractJSON, quickFixJSON, validateJSON } from '../core/structuredOutput.js'
import { addStep, startSpan, endSpan } from '../core/tracer.js'
import { estimateTextTokens } from '../core/tokenBudget.js'

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    interests: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 24 },
          confidence: { type: 'number', minimum: 0.3, maximum: 1 },
          evidence: { type: 'string', maxLength: 80 },
        },
        required: ['name', 'confidence'],
      },
    },
    socialStyle: {
      type: 'object', additionalProperties: false,
      properties: {
        energy: { type: 'string', enum: ['introvert', 'extrovert', 'ambivert', 'unknown'] },
        depth: { type: 'string', enum: ['surface', 'deep', 'mixed', 'unknown'] },
      },
    },
    schedule: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 16 } },
    goal: { type: 'string', maxLength: 60 },
    constraints: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 30 } },
  },
}

// 文件路径：server/src/agents/profileAgent.ts
export interface RecentMessage {
  role: 'user' | 'assistant'
  content: string
}

// 文件路径：server/src/agents/profileAgent.ts → ProfileAgent
export class ProfileAgent extends BaseAgent<ProfileAgentInput, ProfileAgentOutput> {
  readonly agentId = 'profile-agent'
  readonly description = '通过多轮对话隐式采集用户画像'

  /**
   * execute() — ProfileAgent 的"干活"方法（由基类 run() 调用）
   *
   * 流程（5 步）：
   *   1. 抽取画像 patch（从对话里挖兴趣/风格/目标）
   *   2. 合并 patch 到现有画像（增量更新）
   *   3. 持久化到 DB（profiles + profile_patches 表）
   *   4. 画像变化时重算向量（MatchAgent 召回用）
   *   5. 写黑板（其他 Agent 可读到最新画像）
   *
   * 注意：这个方法是异步在 chat.ts 后台跑的，不阻塞用户看回复
   */
  protected async execute(input: ProfileAgentInput, ctx: AgentContext): Promise<ProfileAgentOutput> {
    const span = startSpan('profile-agent', { userId: ctx.userId, mode: llmEnabled ? 'llm' : 'fallback' })

    // 1. 抽取画像 patch（LLM 优先，降级关键词）
    const patch = await this.extractProfile(input.recentMessages, ctx)

    // 2. 加载现有画像 + 合并 patch（增量更新，不是覆盖）
    const current = loadProfile(ctx.userId) || createEmptyProfile(ctx.userId)
    const next = applyPatch(current, patch)   // applyPatch 在 profileSchema.ts 里实现

    // 3. 持久化：主表 profiles 存最新画像，附表 profile_patches 存每次变更（审计用）
    persistProfile(ctx.userId, ctx.tenantId, next)
    if (hasPatchContent(patch)) persistPatch(ctx.userId, ctx.tenantId, next.basic.version, patch)

    // 4. 画像变化时重算向量（向量是 MatchAgent 召回的核心）
    if (next.confidence > current.confidence || next.basic.version === 1) {
      const text = profileToText(next)        // 画像 → 纯文本（喂给 embedding）
      const vec = await embed(text)            // 文本 → 1536 维向量
      updateProfileEmbedding(ctx.userId, vec)  // 存回 profiles.embedding 字段
      addStep('extract', { event: 'embedding_updated', dim: vec.length })
    }

    // 5. 写黑板：其他 Agent 可读到最新画像（黑板是 Agent 间通信的"公告板"）
    ctx.blackboard.write(this.agentId, 'latest_profile', next, 'profile_patch')
    ctx.blackboard.write(this.agentId, 'latest_patch', patch, 'profile_patch')

    // 6. ★ 写长期记忆（Layer 2）：让 MatchAgent/IceBreakerAgent 能读到历史画像
    //   场景：用户下周再来，MatchAgent 能从长期记忆读到这次抽的画像
    try {
      profileAdapter.onProfileExtracted(ctx.userId, patch)
    } catch (err) {
      // 记忆写入失败不致命，主流程继续
      addStep('info', { event: 'memory_write_failed', error: (err as Error).message })
    }

    ctx.budget.recordInput(estimateTextTokens(JSON.stringify(input.recentMessages)))

    endSpan({ confidence: next.confidence, version: next.basic.version })
    return {
      profile: next,
      patch,
      confidence: next.confidence,
      profileText: profileToText(next),
    }
  }

  /**
   * extractProfile() — 抽取画像 patch（双模式入口）
   *
   * @param messages - 最近对话历史
   * @returns ProfilePatch - 画像增量（不是完整画像）
   *
   * 调用链：
   *   execute() → extractProfile() → extractViaLLM()（LLM 模式）
   *                                → extractViaKeywords()（降级模式）
   */
  async extractProfile(messages: RecentMessage[], ctx: AgentContext): Promise<ProfilePatch> {
    if (llmEnabled) {
      try {
        return await this.extractViaLLM(messages, ctx)
      } catch (e) {
        // LLM 失败不致命，降级到关键词（保证系统可用）
        addStep('info', { event: 'llm_extract_failed', error: (e as Error).message })
      }
    }
    return extractViaKeywords(messages)
  }

  private async extractViaLLM(messages: RecentMessage[], ctx: AgentContext): Promise<ProfilePatch> {
    const recent = messages.slice(-config.profile.maxRoundsKept)
    const sys: ChatMessage = {
      role: 'system',
      content: `你是用户画像抽取器。从对话中提取用户的社交匹配画像，输出严格 JSON。
字段说明：
- interests: 兴趣数组，每项含 name(中文短词)、confidence(0.3-1)、evidence(用户原话片段，可选)
- socialStyle: { energy: introvert/extrovert/ambivert/unknown, depth: surface/deep/mixed/unknown }
- schedule: 活跃时段数组(如 evening/weekend/weekday)
- goal: 找搭子的目标(一句话)
- constraints: 限制条件(如地点/年龄偏好)
只输出 JSON，不要解释。无新信息则输出空对象 {}。`,
    }
    const user: ChatMessage = {
      role: 'user',
      content: '对话记录：\n' + recent.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n'),
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      // 推理模型需更大 maxTokens：reasoning token + content token 都算
      const { text, usage } = await chatOnce([sys, user], { maxTokens: 2048, temperature: 0.2 })
      ctx.budget.recordApiUsage(usage.inputTokens, usage.outputTokens)
      addStep('llm_call', { attempt, model: config.llm.model }, usage.inputTokens + usage.outputTokens)
      const raw = quickFixJSON(text)
      const parsed = extractJSON(raw)
      if (parsed) {
        const { valid, errors } = validateJSON(parsed, PATCH_SCHEMA)
        if (valid) {
          ctx.loopDetector.recordAction('extract_profile', { attempt }, 'ok')
          return parsed as ProfilePatch
        }
        addStep('info', { event: 'schema_validation_failed', errors, attempt })
        if (attempt === 1) throw new Error(`画像 schema 校验失败: ${errors.join('; ')}`)
      } else {
        if (attempt === 1) throw new Error('画像抽取 JSON 解析失败')
      }
    }
    throw new Error('画像抽取重试耗尽')
  }

  /**
   * streamReply() — 流式生成对话回复（链路最热路径）
   *
   * 这是 chat.ts 直接调的方法，用户发消息后立刻执行
   * 返回的 delta 通过 SSE 实时推给前端，用户秒看到 AI 打字
   *
   * 双模式：
   *   - LLM 模式：streamReplyLLM() 调 chatStream 真流式
   *   - 降级模式：templateReply 逐字符模拟流式（体验一致）
   *
   * @param messages     - 最近对话（system + history）
   * @param profile      - 当前用户画像（AI 据此个性化回复）
   * @param onDelta      - 每来一块正文调一次（推前端 SSE 'delta' 事件）
   * @param ctx          - 上下文
   * @param signal       - 中止信号（用户关页面时取消）
   * @param onReasoning  - 推理模型思考过程回调（推前端 SSE 'reasoning' 事件）
   * @returns { text, reasoning } - 完整正文 + 完整思考过程
   *
   * 调用方：chat.ts 的 POST /messages 路由
   */
  async streamReply(
    messages: RecentMessage[],
    profile: Profile,
    onDelta: (text: string) => void,
    ctx: AgentContext,
    signal?: AbortSignal,
    onReasoning?: (text: string) => void,
    sessionId?: string,
  ): Promise<{ text: string; reasoning: string }> {
    if (llmEnabled) {
      try {
        return await this.streamReplyLLM(messages, profile, onDelta, ctx, signal, onReasoning, sessionId)
      } catch (e) {
        // LLM 失败降级到模板，保证用户总有回复（不能让聊天卡死）
        addStep('info', { event: 'llm_reply_failed', error: (e as Error).message })
      }
    }
    const reply = templateReply(profile)
    // 降级模式：逐字符调 onDelta，模拟流式体验（每字停 8ms）
    for (const ch of reply) {
      onDelta(ch)
      if (ch !== ' ') await sleep(8)
    }
    return { text: reply, reasoning: '' }
  }

  /**
   * streamReplyLLM() — LLM 模式的流式回复（私有方法）
   *
   * 构造 system prompt（含画像+对话原则）+ history，调 chatStream
   * chatStream 内部逐 token 回调 onDelta/onReasoning，最终返回完整文本
   *
   * @private 只在类内部调用（streamReply 调它）
   */
  private async streamReplyLLM(
    messages: RecentMessage[],
    profile: Profile,
    onDelta: (text: string) => void,
    ctx: AgentContext,
    signal: AbortSignal | undefined,
    onReasoning?: (text: string) => void,
    sessionId?: string,
  ): Promise<{ text: string; reasoning: string }> {
    const profileSummary = profileToText(profile) || '（画像采集中）'
    const sysContent = `你是"搭子匹配官"，一个温暖、专业的社交匹配助手。你在和用户自然聊天，目标是了解TA的兴趣、社交风格、找搭子目标，以便后续精准匹配。

当前已知的用户画像：${profileSummary}

对话原则：
1. 像朋友聊天，绝不审问、不一次问太多
2. 每轮只聚焦1个方向，根据用户回答自然追问或转移
3. 用户说得越具体越好（喜欢什么运动/什么音乐/周末做什么）
4. 不要复述用户的话，不要说"好的""了解了"等废话
5. 当画像较完整（兴趣≥3个、风格明确、目标清晰）时，可以温和提示"我觉得可以帮你找搭子了"
6. 回复控制在2-3句话，自然口语化

场景图片返问（助力找搭子）：
- 当想了解用户偏好的活动场景（如爬山/咖啡/图书馆/健身房/露营等）时，
  可以输出 [gen:图片描述] 标记，前端会把它渲染成一张 AI 生成的真实图片。
- 一次最多输出 3 个 [gen:...] 标记，配上一句引导，如：
  "周末想怎么过？选个感觉：" 然后换行列出 [gen:山顶日出 写实 风景] [gen:咖啡馆 温馨 室内] [gen:图书馆 安静 室内]
- 图片描述用中文+风格词（写实/动漫/水彩），描述越具体出图越准。
- 不要每轮都用，只在需要了解活动偏好时用，避免刷屏。
- 用户发了图片（content 里带 [用户发送了N张图片]）时，可以温和追问图里的活动，但你知道自己看不到图片内容。`

    // ★ 接入 cache 模块：用 chatWithCache 替代 chatStream
    //   cache 模块内部维护 prefix(system) + log(对话历史)，
    //   自动命中 DeepSeek prefix cache（命中部分按 ¥0.1/M 计费，省 90%）
    //   - 只传最新 user message，cache 模块自己拼完整 history
    //   - 如果没有 sessionId（异常情况），降级到 chatStream
    const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]

    if (sessionId && lastUserMsg) {
      // ★ 主路径：走 cache（省钱）
      const result = await chatWithCache(
        ctx.userId,
        sessionId,
        sysContent,
        lastUserMsg.content,
        {
          onText: onDelta,
          onReasoning,
          onUsage: (u: unknown) => {
            // chatWithCache 返回 CacheUsagePayload（字段名 promptTokens/completionTokens）
            const cu = u as { promptTokens?: number; completionTokens?: number }
            ctx.budget.recordApiUsage(
              cu.promptTokens || 0,
              cu.completionTokens || 0,
            )
          },
        },
        { signal, maxTokens: 8192, temperature: 0.7 },
      )
      // ★ cache 模块返回 CacheUsagePayload（不是 LLMUsage），字段名要对应
      const cu = result.usage as {
        promptTokens: number
        completionTokens: number
        promptCacheHitTokens?: number
        promptCacheMissTokens?: number
      }
      const inputTokens = cu.promptTokens || 0
      const outputTokens = cu.completionTokens || 0
      addStep('llm_call', {
        event: 'reply.cached',
        model: config.llm.model,
        cacheHit: cu.promptCacheHitTokens || 0,
        cacheMiss: cu.promptCacheMissTokens || 0,
      }, inputTokens + outputTokens)

      // ★ Layer 1 记忆写入已改由 chat.ts 统一管理（避免重复）
      return { text: result.text, reasoning: result.reasoning }
    }

    // 降级路径：无 sessionId，直接调 chatStream（无缓存优化）
    const history: ChatMessage[] = messages.slice(-12).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }))
    const { text, reasoning, usage } = await chatStream(
      [{ role: 'system', content: sysContent }, ...history],
      {
        onDelta,
        onReasoning,
        onUsage: (u) => ctx.budget.recordApiUsage(u.inputTokens, u.outputTokens),
      },
      { maxTokens: 8192, temperature: 0.7, signal },
    )
    addStep('llm_call', { event: 'reply.uncached', model: config.llm.model }, usage.inputTokens + usage.outputTokens)
    return { text, reasoning }
  }
}

// 文件路径：server/src/agents/profileAgent.ts
export interface ProfileAgentInput {
  recentMessages: RecentMessage[]
}

// 文件路径：server/src/agents/profileAgent.ts
export interface ProfileAgentOutput {
  profile: Profile
  patch: ProfilePatch
  confidence: number
  profileText: string
}

// ─── 降级：关键词抽取 ───
// 文件路径：server/src/agents/profileAgent.ts → extractViaKeywords()
function extractViaKeywords(messages: RecentMessage[]): ProfilePatch {
  const patch: ProfilePatch = { interests: [] }
  const userText = messages.filter(m => m.role === 'user').map(m => m.content).join(' ')

  const interestMap: Record<string, string[]> = {
    '运动': ['跑步', '健身', '游泳', '瑜伽', '篮球', '足球', '羽毛球', '网球', '骑行', '爬山', '徒步', '攀岩'],
    '音乐': ['音乐', '唱歌', '吉他', '钢琴', '乐队', '演唱会', '说唱', '摇滚', '古典'],
    '影视': ['电影', '电视剧', '动漫', '综艺', '纪录片', 'Netflix'],
    '游戏': ['游戏', '手游', '主机', 'Switch', 'PS5', 'Steam', 'LOL', '王者荣耀'],
    '美食': ['美食', '探店', '做饭', '烘焙', '咖啡', '品酒'],
    '读书': ['读书', '看书', '小说', '历史', '哲学', '心理学'],
    '旅行': ['旅行', '旅游', '自驾', '露营', '摄影'],
    '学习': ['英语', '编程', '考研', '考证', '学习'],
  }
  for (const [cat, kws] of Object.entries(interestMap)) {
    for (const kw of kws) {
      if (userText.includes(kw)) {
        if (!patch.interests!.find(i => i.name === cat)) {
          patch.interests!.push({ name: cat, confidence: 0.6, evidence: kw })
        }
        break
      }
    }
  }

  if (/内向|安静|宅|i人/.test(userText)) patch.socialStyle = { energy: 'introvert' }
  else if (/外向|活泼|社交|e人/.test(userText)) patch.socialStyle = { energy: 'extrovert' }

  if (/深度|交心|真诚|认真/.test(userText)) patch.socialStyle = { ...patch.socialStyle, depth: 'deep' }
  else if (/随便|轻松|玩玩|聊聊/.test(userText)) patch.socialStyle = { ...patch.socialStyle, depth: 'surface' }

  if (/周末|weekday/.test(userText)) patch.schedule = ['weekend']
  if (/晚上|下班后/.test(userText)) patch.schedule = [...(patch.schedule || []), 'evening']

  const goalMatch = userText.match(/找.{0,6}搭子|想.{0,10}一起|希望.{0,10}一起/)
  if (goalMatch) patch.goal = goalMatch[0].slice(0, 60)

  return patch
}

// 文件路径：server/src/agents/profileAgent.ts → templateReply()
function templateReply(profile: Profile): string {
  if (profile.interests.length === 0) {
    const openers = [
      '嗨，先随便聊聊～你平时周末一般怎么过？',
      '你好呀！最近有什么让你投入的事情吗？',
      '认识你很高兴。如果不忙的时候，你最喜欢做什么？',
    ]
    return openers[Math.floor(Math.random() * openers.length)]
  }
  if (profile.interests.length < 3) {
    const i = profile.interests[0]!.name
    return `听起来你对${i}挺感兴趣的，最近还在做这个吗？除了${i}，平时还会接触别的吗？`
  }
  if (profile.socialStyle.energy === 'unknown') {
    return '了解了你的兴趣～想再了解下，你是喜欢一个人安静地做这些，还是更享受有人一起？'
  }
  if (!profile.goal) {
    return '你的画像挺清晰了。这次想找个什么样的搭子呢？比如一起做什么、什么节奏？'
  }
  return '我觉得对你的了解差不多了，可以点"开始匹配"帮你找搭子，也可以继续聊～'
}

// 文件路径：server/src/agents/profileAgent.ts → hasPatchContent()
function hasPatchContent(p: ProfilePatch): boolean {
  return !!(
    (p.interests && p.interests.length) ||
    p.socialStyle?.energy || p.socialStyle?.depth ||
    p.schedule?.length || p.goal || p.constraints?.length
  )
}

// ─── DB 持久化 ───
// 文件路径：server/src/agents/profileAgent.ts → loadProfile()
function loadProfile(userId: string): Profile | null {
  const db = getDB()
  const row = db.prepare('SELECT profile_json FROM profiles WHERE user_id = ?').get(userId) as { profile_json: string } | undefined
  if (!row || !row.profile_json || row.profile_json === '{}') return null
  try { return JSON.parse(row.profile_json) as Profile } catch { return null }
}

// 文件路径：server/src/agents/profileAgent.ts → persistProfile()
function persistProfile(userId: string, tenantId: string, p: Profile): void {
  const db = getDB()
  const exists = db.prepare('SELECT 1 FROM profiles WHERE user_id = ?').get(userId)
  if (exists) {
    db.prepare(`
      UPDATE profiles SET profile_json = ?, confidence = ?, version = ?, updated_at = unixepoch()
      WHERE user_id = ?
    `).run(JSON.stringify(p), p.confidence, p.basic.version, userId)
  } else {
    db.prepare(`
      INSERT INTO profiles (user_id, tenant_id, profile_json, confidence, version)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, tenantId, JSON.stringify(p), p.confidence, p.basic.version)
  }
}

// 文件路径：server/src/agents/profileAgent.ts → persistPatch()
function persistPatch(userId: string, tenantId: string, version: number, patch: ProfilePatch): void {
  const db = getDB()
  db.prepare(`
    INSERT INTO profile_patches (user_id, tenant_id, version, patch_json)
    VALUES (?, ?, ?, ?)
  `).run(userId, tenantId, version, JSON.stringify(patch))
}

// 文件路径：server/src/agents/profileAgent.ts → updateProfileEmbedding()
function updateProfileEmbedding(userId: string, vec: number[]): void {
  const db = getDB()
  db.prepare('UPDATE profiles SET embedding = ? WHERE user_id = ?').run(JSON.stringify(vec), userId)
}

// 文件路径：server/src/agents/profileAgent.ts → sleep()
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// 重新导出工具函数供路由使用
export { computeConfidence, profileToText, loadProfile, persistProfile }
