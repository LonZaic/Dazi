// ============================================================
// mbtiExtractor.ts — MBTI 信号抽取器（双模式：LLM + 关键词兜底）
// 文件路径：server/src/mbti/mbtiExtractor.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件从用户的聊天对话里"偷抽" MBTI 4 维信号。            ║
// ║                                                            ║
// ║  和 Dazi 已有的 profileAgent.ts 设计哲学完全一致：          ║
// ║  - 不让用户填表！从自然对话里挖                             ║
// ║  - 双模式：有 LLM 用 LLM 抽（准），无 LLM 用关键词（能跑）   ║
// ║  - 输出带置信度 + evidence 原话（可审计）                   ║
// ║                                                            ║
// ║  为啥不直接问用户"你是 I 人还是 E 人"？                      ║
// ║  - 用户填表累（Dazi 核心反表单原则）                        ║
// ║  - 用户自己测的 MBTI 不准（自评偏差）                       ║
// ║  - AI 从行为语言推断更客观（"我喜欢一个人看书" 比"我是 I"可信）║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王聊天内容 → MBTI 信号 ▼▼▼
//
//   小王聊了 5 句话：
//     "我喜欢一个人安静地看书"          → EI: I (0.7)
//     "经常思考人生的意义"              → SN: N (0.6)
//     "和朋友矛盾时我会先分析对错"      → TF: T (0.6)
//     "出门前总要列清单"                → JP: J (0.6)
//     "讨厌被打乱计划"                  → JP: J (0.7)
//
//   LLM 模式（有 API Key）：
//     把这 5 句话喂给 DeepSeek，让它输出 JSON：
//       [
//         {"dimension":"EI","pole":"I","confidence":0.7,"evidence":["喜欢一个人安静地看书"]},
//         {"dimension":"SN","pole":"N","confidence":0.6,"evidence":["思考人生意义"]},
//         {"dimension":"TF","pole":"T","confidence":0.6,"evidence":["分析对错"]},
//         {"dimension":"JP","pole":"J","confidence":0.7,"evidence":["列清单","讨厌被打乱计划"]}
//       ]
//
//   关键词模式（无 API Key 或 LLM 失败）：
//     正则匹配：
//       "一个人/安静/独处/内向" → EI: I (0.6)
//       "思考/意义/想象/未来" → SN: N (0.55)
//       "分析/对错/逻辑/理性" → TF: T (0.55)
//       "计划/清单/安排/讨厌被打乱" → JP: J (0.6)
//     精度低但能跑，保证系统可用
//
// ════════════════════════════════════════════════════════════
//  【和 Dazi 已有 profileAgent 的协作】
// ════════════════════════════════════════════════════════════
//   Dazi 已有：profileAgent.run() 异步后台抽 ProfilePatch
//   新增（零侵入）：在 chat.ts 的 .then() 回调里再 fire-and-forget 调
//                  mbtiExtractor.extract(messages)
//   两次抽取并行，互不阻塞，互不修改对方代码
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   chat.ts 流式回复完 → profileAgent.run()（已有）
//                           │
//                           ▼ （新增 hook，零侵入）
//                     mbtiExtractor.extract(messages)
//                           │
//                           ▼
//                     mbtiEngine.applyDimensionPatch(old, signals)
//                           │
//                           ▼
//                     memory/longTermProfileMemory.write(userId, mbtiProfile)
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - integrations/agentMemoryAdapter.ts（chat 后台 hook）
//
//   它调用：
//   - ../services/llmClient.js → chatOnce（LLM 抽取，复用已有客户端）
//   - ../core/structuredOutput.js → JSON 抽取+校验（复用已有工具）
//   - ./mbtiTypes.js → MbtiDimensionSignal 类型
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - async/await：异步调 LLM
//   - try/catch：LLM 失败降级到关键词
//   - readonly：纯函数纪律
//   - Record<K, V>：关键词字典
// ============================================================

import { chatOnce, llmEnabled, type ChatMessage } from '../services/llmClient.js'
import { extractJSON, quickFixJSON, validateJSON } from '../core/structuredOutput.js'
import { addStep } from '../core/tracer.js'
import {
  type MbtiDimensionSignal,
  type MbtiDimension,
  type MbtiPole,
  DIMENSION_POLES,
} from './mbtiTypes.js'

// ─── JSON Schema 校验：LLM 输出的 MBTI 信号必须满足这个 schema ───
// 文件路径：server/src/mbti/mbtiExtractor.ts
//   注意：不能用 `as const`，否则 enum 数组会变成 readonly tuple，
//   和 validateJSON 期望的 JsonSchema 不兼容
const MBTI_SIGNAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    signals: {
      type: 'array',
      maxItems: 4,   // 最多 4 个（4 个维度）
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dimension: { type: 'string', enum: ['EI', 'SN', 'TF', 'JP'] },
          pole: { type: 'string', enum: ['E', 'I', 'S', 'N', 'T', 'F', 'J', 'P'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        },
        required: ['dimension', 'pole', 'confidence', 'evidence'],
      },
    },
  },
  required: ['signals'],
}

// ─── 关键词字典（无 LLM 时的兜底）───
// 文件路径：server/src/mbti/mbtiExtractor.ts
//   key=正则片段，匹配上就给对应极信号（confidence 固定 0.55，弱信号）
const KEYWORD_RULES: { dimension: MbtiDimension; pole: MbtiPole; re: RegExp }[] = [
  // EI 外向/内向
  { dimension: 'EI', pole: 'I', re: /一个人|安静|独处|内向|宅|自己待|不想见人|社交疲惫|电量/ },
  { dimension: 'EI', pole: 'E', re: /朋友聚|热闹|party|派对|人越多|一起玩|热闹|聚会|外向|认识新/ },
  // SN 实感/直觉
  { dimension: 'SN', pole: 'N', re: /思考|意义|想象|未来|可能性|为什么|本质|灵感|梦想|抽象|哲学/ },
  { dimension: 'SN', pole: 'S', re: /具体|细节|实际|事实|经验|现实|步骤|操作|看到|听到的|当下/ },
  // TF 思考/情感
  { dimension: 'TF', pole: 'T', re: /分析|逻辑|对错|理性|客观|利弊|权衡|效率|原理|数据/ },
  { dimension: 'TF', pole: 'F', re: /感受|心情|在意|关心|共情|价值观|舒服|开心|难过|喜欢|讨厌/ },
  // JP 判断/感知
  { dimension: 'JP', pole: 'J', re: /计划|清单|安排|准时|目标|完成|deadline|讨厌被打乱|规划|提前/ },
  { dimension: 'JP', pole: 'P', re: /随性|灵活|临时|看心情|再说|拖一下|弹性|不着急|自由| spont/ },
]

/**
 * extract() — 主入口：从对话消息里抽 MBTI 4 维信号
 * 文件路径：server/src/mbti/mbtiExtractor.ts → extract()
 *
 * @param messages - 最近几条对话（最多 12 条，避免 token 爆）
 * @returns 4 维信号数组（已合并去重，可直接喂 applyDimensionPatch）
 *
 * 双模式策略：
 *   1. llmEnabled=true → LLM 抽（精度高，调 chatOnce + JSON schema 校验）
 *   2. LLM 失败 或 llmEnabled=false → 关键词兜底（保可用）
 *
 * 场景：用户聊了 8 句，profileAgent 已经抽过画像 patch，
 *      这里再异步抽 MBTI 信号（两次抽取并行不互扰）
 */
export async function extract(
  messages: readonly ChatMessage[],
): Promise<MbtiDimensionSignal[]> {
  // 空消息直接返回空信号（不浪费 token）
  if (messages.length === 0) return []

  addStep('extract', { phase: 'mbti-extract', msgCount: messages.length, llmEnabled })

  // 优先 LLM 模式
  if (llmEnabled) {
    try {
      const llmResult = await extractWithLLM(messages)
      if (llmResult.length > 0) {
        addStep('extract', { phase: 'mbti-extract', mode: 'llm', signals: llmResult.length })
        return llmResult
      }
    } catch (e) {
      // LLM 失败不致命，降级到关键词
      addStep('info', { phase: 'mbti-extract', mode: 'llm_failed', error: (e as Error).message })
    }
  }

  // 关键词兜底
  const kwResult = extractWithKeywords(messages)
  addStep('extract', { phase: 'mbti-extract', mode: 'keyword', signals: kwResult.length })
  return kwResult
}

/**
 * extractWithLLM() — LLM 模式：调 DeepSeek 抽 MBTI 信号
 * 文件路径：server/src/mbti/mbtiExtractor.ts → extractWithLLM()
 *
 * 设计要点（和 Reasonix 省钱策略呼应）：
 *   - system prompt 固定不变（命中 DeepSeek 前缀缓存）
 *   - 只把用户对话 append 到 user 消息末尾（不改 system）
 *   - 输出强制 JSON，用 structuredOutput 校验
 *
 * @param messages - 用户对话
 * @returns 4 维信号数组
 */
async function extractWithLLM(messages: readonly ChatMessage[]): Promise<MbtiDimensionSignal[]> {
  // 拼对话文本（最多取最近 12 条，避免 token 爆炸）
  const recent = messages.slice(-12)
  const dialogText = recent
    .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
    .join('\n')

  const sysPrompt = `你是 MBTI 行为分析专家。从用户对话里推断 MBTI 4 维度倾向。

输出 JSON，格式严格如下：
{"signals":[{"dimension":"EI|SN|TF|JP","pole":"E|I|S|N|T|F|J|P","confidence":0.0-1.0,"evidence":["原话片段最多3条"]}]}

维度判断要点：
- EI: 能量来源（独处充电=I / 社交充电=E）
- SN: 信息收集（具体细节=S / 抽象意义=N）
- TF: 决策方式（逻辑对错=T / 价值感受=F）
- JP: 生活方式（计划秩序=J / 灵活开放=P）

规则：
1. confidence 0-1，不确定就给低值（0.3-0.5），别瞎猜
2. evidence 必须是用户原话片段（≤15字）
3. 只输出 JSON，不要任何额外文字`

  const userMsg: ChatMessage = {
    role: 'user',
    content: `请分析以下对话，输出 MBTI 信号 JSON：\n\n${dialogText}`,
  }

  // 调 DeepSeek（chatOnce 是已有的非流式调用）
  const result = await chatOnce(
    [{ role: 'system', content: sysPrompt }, userMsg],
    { maxTokens: 600, temperature: 0.3 },   // 低温度，要稳定的结构化输出
  )

  // 解析 + 修复 + 校验 JSON
  //   quickFixJSON 返回修复后的字符串，需要再 JSON.parse 解析
  let raw: unknown = extractJSON(result.text)
  if (!raw) {
    const fixed = quickFixJSON(result.text)
    try {
      raw = JSON.parse(fixed)
    } catch {
      throw new Error('LLM 输出无法解析为 JSON')
    }
  }
  if (!raw) throw new Error('LLM 输出无 JSON')

  const ok = validateJSON(raw, MBTI_SIGNAL_SCHEMA)
  if (!ok.valid) throw new Error(`JSON 校验失败: ${ok.errors.join('; ')}`)

  const signals = (raw as { signals: MbtiDimensionSignal[] }).signals
  // 二次过滤：confidence < 0.3 视为噪音丢弃
  return signals.filter(s => s.confidence >= 0.3)
}

/**
 * extractWithKeywords() — 关键词模式：正则匹配兜底
 * 文件路径：server/src/mbti/mbtiExtractor.ts → extractWithKeywords()
 *
 * 规则：
 *   - 遍历 KEYWORD_RULES，每个匹配的规则产生一个信号
 *   - 同维度可能多个信号，按极聚合，evidence 累加
 *   - confidence 固定 0.55（弱信号，让引擎的增量合并机制处理）
 *
 * 场景：无 API Key 或 LLM 失败时保证系统可用
 */
function extractWithKeywords(messages: readonly ChatMessage[]): MbtiDimensionSignal[] {
  // 把所有 user 消息拼成一段文本
  const text = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join('\n')

  if (!text) return []

  // 按维度+极聚合信号
  //   key = "EI:I" / "SN:N" / ...
  const bucket = new Map<string, MbtiDimensionSignal>()

  for (const rule of KEYWORD_RULES) {
    const matches = text.match(new RegExp(rule.re.source, 'g'))
    if (!matches) continue

    const key = `${rule.dimension}:${rule.pole}`
    const existing = bucket.get(key)
    if (existing) {
      // 同极累加：confidence 略增（最多 0.75 封顶），evidence 累加
      existing.confidence = Math.min(0.75, existing.confidence + 0.05)
      for (const m of matches.slice(0, 2)) {
        if (!existing.evidence.includes(m)) existing.evidence.push(m)
      }
      if (existing.evidence.length > 3) existing.evidence = existing.evidence.slice(-3)
    } else {
      bucket.set(key, {
        dimension: rule.dimension,
        pole: rule.pole,
        confidence: 0.55,
        evidence: matches.slice(0, 3),
      })
    }
  }

  // 每维度只保留 confidence 最高的极（同维度不同极取强的）
  //   场景：用户既说"安静"又"朋友聚" → EI 维度两极都有信号 → 取强的
  const byDim = new Map<MbtiDimension, MbtiDimensionSignal>()
  for (const sig of bucket.values()) {
    const cur = byDim.get(sig.dimension)
    if (!cur || sig.confidence > cur.confidence) {
      byDim.set(sig.dimension, sig)
    }
  }

  return Array.from(byDim.values())
}

// ─── 重导出 ───
// 文件路径：server/src/mbti/mbtiExtractor.ts
export { DIMENSION_POLES } from './mbtiTypes.js'