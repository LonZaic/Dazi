// ============================================================
// iceBreakerAgent.ts — 破冰话术 Agent（链路核心 #3）
// 文件路径：server/src/agents/iceBreakerAgent.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个 Agent 是"破冰话术师"——匹配成功后，帮用户写出第一句      ║
// ║  开场白。社交最大障碍是"不知道第一句说啥"，这个 Agent 帮你      ║
// ║  生成 3 条不同风格的话术，复制粘贴就能发。                     ║
// ║                                                            ║
// ║  核心价值：降低社交启动成本。                                  ║
// ║  传统 App 匹配完就完了，用户大眼瞪小眼。                      ║
// ║  本系统多走一步：AI 帮你写好开场白。                          ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王点"要破冰话术"，IceBreakerAgent 干了啥 ▼▼▼
//
//   小王匹配到小李（综合分 0.77），点"生成破冰话术"按钮
//        │
//        ▼
//   POST /api/match/icebreaker（routes/match.ts）
//        │  body: { targetUserId: '小李的ID' }
//        ▼
//   iceBreakerAgent.run(input, ctx)
//        │  input = {
//        │    targetUserId: '小李',
//        │    targetProfile: { interests:['跑步','爬山'], socialStyle:{energy:'introvert'} },
//        │    myInterests: ['跑步','游戏'],
//        │    commonInterests: ['跑步'],     ← 共同兴趣
//        │    matchScore: 0.77
//        │  }
//        ▼
//   execute() 干 3 步：
//
//   ① LLM 可用 → generateLLM(input)
//      - 拼 system prompt："你是破冰专家，生成3条不同风格开场白"
//      - 拼 user prompt：只传画像标签（兴趣/风格/目标），不传对话原文（隐私！）
//        → "我的兴趣：跑步、游戏
//           对方兴趣：跑步、爬山
//           共同兴趣：跑步
//           匹配度：77%"
//      - 调 chatOnce（非流式，话术短）
//      - 解析 JSON 数组 → ["看到你也喜欢跑步...", "两个i人的默契...", ...]
//      - 失败 → 降级模板
//
//   ② LLM 不可用/失败 → generateTemplate(input)
//      - 纯 JS 拼装，不调 LLM
//      - 3 条模板：
//        a. 基于共同兴趣："看到你也喜欢跑步，最近有在跑吗？"
//        b. 轻松幽默（按对方风格调整）："两个i人的默契：安静待着..."
//        c. 真诚直接："我是认真想找搭子..."
//
//   ③ persistIcebreakers() 存 DB
//      - 更新 matches 表 icebreakers_json 字段
//      - 标记 state='icebroken'
//      - 状态机 transition → ICEBREAKING → DONE
//
//   返回前端 → 用户看到 3 条话术，复制一条就能发私信
//
// ════════════════════════════════════════════════════════════
//  【双模式设计】（保证可跑 + 省钱）
// ════════════════════════════════════════════════════════════
//   - LLM 模式：有 API Key → 调 DeepSeek 生成（智能、有创意、花钱）
//   - 降级模式：无 Key/出错 → 用模板拼装（机械但永远能用、免费）
//
//   降级为什么重要？
//   - API 可能挂/超时/没钱
//   - 用户点"破冰"不能没响应（体验崩）
//   - 模板虽傻但能用，至少用户有话术可发
//
// ════════════════════════════════════════════════════════════
//  【隐私保护设计】
// ════════════════════════════════════════════════════════════
//   传给 LLM 的只有"标签"：
//   ✓ 兴趣列表（跑步、爬山）
//   ✓ 社交风格（introvert/deep）
//   ✓ 共同兴趣
//   ✗ 不传对话原文（用户聊天记录绝不外泄）
//   ✗ 不传用户 ID、姓名、私信内容
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   用户聊天 → ProfileAgent 抽画像
//        → MatchAgent 匹配出 5 个候选
//        → 用户选一个 → IceBreakerAgent 生成破冰话术  ← 这里
//        → 用户发私信 → dm.ts 私信路由
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - routes/match.ts: POST /api/match/icebreaker
//
//   它调用：
//   - baseAgent.js → BaseAgent.run()（继承，复用计时/try-catch/token记账）
//   - llmClient.js → chatOnce（调 DeepSeek 生成话术）
//   - structuredOutput.js → quickFixJSON + extractJSON（解析 LLM 输出）
//   - tracer.js → startSpan/endSpan（追踪执行）
//   - db/index.js → 更新 matches 表
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - extends BaseAgent<Input, Output> → 继承基类，填 Input/Output 泛型
//   - readonly agentId = '...' → 只读属性，赋了就不能改
//   - Array.isArray() → 运行时判断是不是数组
//   - JSON.stringify() → 对象转 JSON 字符串（存 DB）
//   - ! 非空断言 → 告诉 TS "我知道这不是 undefined"
// ============================================================

import { BaseAgent, type AgentContext } from './baseAgent.js'
//              ↑ 基类                  ↑ 上下文类型（只导入类型，编译后不存在）
import { type ProfileSnapshot } from '../db/vectorStore.js'
import { getDB } from '../db/index.js'
import { chatOnce, llmEnabled, type ChatMessage } from '../services/llmClient.js'
import { config } from '../config/index.js'
import { addStep, startSpan, endSpan } from '../core/tracer.js'
import { extractJSON, quickFixJSON } from '../core/structuredOutput.js'

// 【interface】破冰师的输入 — 需要哪些信息才能生成话术
// 文件路径：server/src/agents/iceBreakerAgent.ts
export interface IceBreakerInput {
  targetUserId: string            // 目标用户 ID（给谁发）
  targetProfile: ProfileSnapshot  // 对方的画像快照（只含兴趣/风格/目标，不含原文）
  myInterests: string[]           // 我的兴趣列表
  commonInterests: string[]       // 共同兴趣
  matchScore: number              // 匹配分（0-1，告诉破冰师有多合拍）
}

// 【interface】破冰师的输出 — 3 条话术 + 来源标记
// 文件路径：server/src/agents/iceBreakerAgent.ts
export interface IceBreakerOutput {
  icebreakers: string[]       // 3 条破冰话术
  source: 'llm' | 'template'  // 来源：LLM 生成的 还是 模板拼的
}

// 【类】破冰师 Agent
// 文件路径：server/src/agents/iceBreakerAgent.ts
export class IceBreakerAgent extends BaseAgent<IceBreakerInput, IceBreakerOutput> {
  //                               ↑ 继承基类，填输入输出泛型
  //                               基类负责计时/try-catch/token记账，
  //                               这个类只需要写 execute()
  readonly agentId = 'icebreaker-agent'
  readonly description = '生成个性化破冰话术'

  // 【核心方法】干活的入口（基类 run() 会调它）
  protected async execute(input: IceBreakerInput, ctx: AgentContext): Promise<IceBreakerOutput> {
    // 开始追踪（tracer 会记录这次执行）
    const span = startSpan('icebreaker-agent', { 
      target: input.targetUserId, 
      mode: llmEnabled ? 'llm' : 'fallback'  // LLM 可用用 LLM，否则走降级
    })

    // ── 双模式：LLM 优先，降级模板 ──
    if (llmEnabled) {
      try {
        const out = await this.generateLLM(input, ctx)  // 调 LLM 生成
        persistIcebreakers(ctx.tenantId, ctx.userId, input.targetUserId, out)  // 存 DB
        endSpan({ source: 'llm', count: out.length })  // 结束追踪
        return { icebreakers: out, source: 'llm' }
      } catch (e) {
        // LLM 挂了 → 不致命，降级到模板（保证用户永远有话术可用）
        addStep('info', { event: 'llm_icebreaker_failed', error: (e as Error).message })
      }
    }

    // 降级：用模板拼装话术（不调 LLM）
    const out = this.generateTemplate(input)
    persistIcebreakers(ctx.tenantId, ctx.userId, input.targetUserId, out)  // 同样存 DB
    endSpan({ source: 'template', count: out.length })
    return { icebreakers: out, source: 'template' }
  }

  // 【私有方法】LLM 生成破冰话术
  // 文件路径：server/src/agents/iceBreakerAgent.ts → IceBreakerAgent.generateLLM()
  private async generateLLM(input: IceBreakerInput, ctx: AgentContext): Promise<string[]> {
    // ① 构造 system prompt：告诉 LLM 怎么干活
    const sys: ChatMessage = {
      role: 'system',
      content: `你是社交破冰话术专家。根据双方画像生成3条破冰开场白，帮用户自然地开启对话。

要求：
1. 每条不超过30字，口语化、有温度
2. 3条风格不同：一条基于共同兴趣、一条轻松幽默、一条真诚直接
3. 不要用"你好""在吗"等无效开场
4. 输出 JSON 数组格式：["话术1","话术2","话术3"]`,
    }

    // ② 构造 user message：只传画像标签，不传对话原文（隐私保护）
    const user: ChatMessage = {
      role: 'user',
      content: `我的兴趣：${input.myInterests.join('、') || '未明确'}
对方兴趣：${input.targetProfile.interests.join('、') || '未明确'}
共同兴趣：${input.commonInterests.join('、') || '暂无'}
对方社交风格：${input.targetProfile.socialStyle.energy}/${input.targetProfile.socialStyle.depth}
对方目标：${input.targetProfile.goal || '未明确'}
匹配度：${Math.round(input.matchScore * 100)}%`,
      //      ↑ Math.round：四舍五入（0.85 → 85）
    }

    // ③ 调 LLM 一次性请求（不用流式，话术很短）
    const { text, usage } = await chatOnce([sys, user], { 
      maxTokens: 256,      // 话术就 3 条每条约 30 字，256 token 够
      temperature: 0.8     // 温度偏高 → 增加创意多样性
    })

    // ④ 记账：记录 token 消耗
    ctx.budget.recordApiUsage(usage.inputTokens, usage.outputTokens)
    addStep('llm_call', { event: 'icebreaker' }, usage.inputTokens + usage.outputTokens)

    // ⑤ 解析 LLM 输出：先修格式 → 抠 JSON → 校验是字符串数组
    const raw = quickFixJSON(text)       // 修尾逗号、去 markdown 包裹
    const parsed = extractJSON(raw)      // 从文本里抠出 JSON
    // Array.isArray：判断是不是数组
    // .every(x => typeof x === 'string')：判断每个元素是不是字符串
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string') && parsed.length > 0) {
      return parsed.slice(0, 3).map(s => String(s).slice(0, 60))
      //          ↑ 最多 3 条     ↑ 每条最多 60 字
    }

    throw new Error('破冰话术解析失败')
  }

  // 【私有方法】模板生成破冰话术（不调 LLM，兜底用）
  // 文件路径：server/src/agents/iceBreakerAgent.ts → IceBreakerAgent.generateTemplate()
  private generateTemplate(input: IceBreakerInput): string[] {
    const out: string[] = []  // 结果数组
    const common = input.commonInterests      // 共同兴趣
    const theirs = input.targetProfile.interests  // 对方的兴趣
    const energy = input.targetProfile.socialStyle.energy  // 对方社交风格

    // ① 基于共同兴趣的开场白
    if (common.length > 0) {
      const i = common[0]!  // ! 是非空断言：告诉 TS "我知道这不是 undefined"
      out.push(`看到你也喜欢${i}，最近有在玩吗？想约个时间一起～`)
    } else if (theirs.length > 0) {
      const i = theirs[0]!
      out.push(`听说你对${i}很有研究，能推荐下入门方式吗？`)
    } else {
      out.push('看了下咱们的画像还挺合拍的，要不先聊聊最近在忙什么？')
    }

    // ② 轻松幽默的开场白（根据对方风格调整语气）
    if (energy === 'introvert') {
      out.push('两个 i 人的默契：可以安静地一起待着，不打扰就是温柔～')
    } else if (energy === 'extrovert') {
      out.push('找到组织了！下次活动算我一个，我来负责气氛组～')
    } else {
      out.push('系统说咱们匹配度挺高，我觉得可以赌一把，先聊为敬～')
    }

    // ③ 真诚直接的开场白
    if (input.targetProfile.goal) {
      out.push(`我看了你的目标是"${input.targetProfile.goal}"，正好我也在找这样的搭子，要不详聊？`)
    } else {
      out.push('我是认真想找个合拍的搭子，看了你的画像觉得挺合适，方便聊聊吗？')
    }

    return out.slice(0, 3)  // 最多返回 3 条
  }
}

// 【辅助函数】把破冰话术存进 DB（更新 matches 表的 icebreakers_json 字段）
// 文件路径：server/src/agents/iceBreakerAgent.ts → persistIcebreakers()
function persistIcebreakers(
  tenantId: string, userA: string, userB: string, icebreakers: string[]
): void {
  const db = getDB()
  db.prepare(`
    UPDATE matches
    SET icebreakers_json = ?, state = 'icebroken', created_at = created_at
    --       ↑ 话术 JSON           ↑ 标记状态为"已破冰"
    WHERE tenant_id = ? AND user_a = ? AND user_b = ?
    ORDER BY id DESC LIMIT 1  -- 只更新最新一条匹配记录
  `).run(
    JSON.stringify(icebreakers),  // 把数组转成 JSON 字符串存进去
    tenantId, userA, userB
  )
}
