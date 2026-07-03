// ============================================================
// llmClient.ts — LLM 客户端（和 DeepSeek API 对话的"电话机"）
// 文件路径：server/src/services/llmClient.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是"和 AI 大脑打电话的电话机"——所有要调 DeepSeek      ║
// ║  的地方都通过它，不直接 fetch。好处：                         ║
// ║  1. 统一管鉴权（API Key 只在这拼）                           ║
// ║  2. 统一管错误（HTTP 失败抛错，上层 catch 降级）              ║
// ║  3. 统一管 token 用量（每条都回报 input/output token）       ║
// ║  4. 统一管 SSE 解析（流式协议解析只写一次）                   ║
// ║                                                            ║
// ║  对外两个函数：                                              ║
// ║  - chatStream：流式（边生成边推，聊天用）                    ║
// ║  - chatOnce：一次性（等完整结果，抽取/破冰用）              ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王发消息"我最近开始跑步了"，LLM 链路 ▼▼▼
//
//   小王发消息 → chat.ts → profileAgent.streamReply()
//        │
//        ▼
//   chatStream([sys, ...history], { onDelta, onReasoning }, opts)
//        │
//        ├── ① POST https://api.deepseek.com/chat/completions
//        │   body: { model:'deepseek-v4-flash', messages, stream:true }
//        │   headers: Authorization: Bearer sk-xxx
//        │
//        ├── ② 响应是 SSE 流（一行一行 data: {...}）
//        │   ┌─ data: {"choices":[{"delta":{"reasoning_content":"用户提到跑步..."}}]}
//        │   │  → onReasoning("用户提到跑步...")  ← 推前端"思考框"
//        │   ├─ data: {"choices":[{"delta":{"content":"听起来"}}]}
//        │   │  → onDelta("听起来")               ← 推前端聊天气泡
//        │   ├─ data: {"choices":[{"delta":{"content":"挺棒！"}}]}
//        │   │  → onDelta("挺棒！")
//        │   └─ data: [DONE]
//        │
//        └── ③ 返回 { text:"听起来挺棒！晨跑还是夜跑？", reasoning:"...", usage:{...} }
//
//   前端秒看到打字效果，reasoning 展示在"思考框"
//
// ════════════════════════════════════════════════════════════
//  【关键概念：推理模型 DeepSeek-v4-flash】
// ════════════════════════════════════════════════════════════
//   普通模型：响应只有 content 字段（直接给答案）
//   推理模型：响应有 content（最终回答）+ reasoning_content（思考过程）
//   推理模型会先"想"再"答"，思考过程展示给用户看更透明
//   所以返回值带 reasoning 字段，前端展示在"思考框"里
//
// ════════════════════════════════════════════════════════════
//  【SSE 流式协议详解】
// ════════════════════════════════════════════════════════════
//   SSE（Server-Sent Events）格式：
//     event: 事件名\n
//     data: JSON字符串\n\n    ← 两个\n表示一条消息结束
//
//   DeepSeek 的流式响应每行一个 data: {...}：
//     data: {"choices":[{"delta":{"content":"你"}}]}
//     data: {"choices":[{"delta":{"content":"好"}}]}
//     data: [DONE]    ← 结束标记
//
//   难点：HTTP 响应是字节流，可能半截断在 "data: {\"choi" 处
//   解法：用 buf 缓冲区暂存不完整的行，下次拼接
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   ProfileAgent.streamReplyLLM() → chatStream() → DeepSeek API
//   ProfileAgent.extractViaLLM()  → chatOnce()  → DeepSeek API
//   IceBreakerAgent.generateLLM() → chatOnce()  → DeepSeek API
//   这是链路"最底层"——再往下就是 HTTP 网络了
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - profileAgent.ts: chatStream（流式回复）、chatOnce（画像抽取）
//   - iceBreakerAgent.ts: chatOnce（破冰话术生成）
//
//   它调用：
//   - ../config/index.js → config（读 LLM_API_BASE/LLM_API_KEY/LLM_MODEL）
//   - 全局 fetch（Node 18+ 内置，无需 import）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - interface：定义数据结构契约
//   - export const：导出常量（llmEnabled 全局只算一次）
//   - async/await：异步编程，等 Promise resolve
//   - ReadableStream + getReader()：Web Streams API，逐块读流
//   - ?. 可选链：choices 为空不报错
// ============================================================
import { config } from '../config/index.js'

// ─── ChatMessage：发给 LLM 的单条消息 ───
// 文件路径：server/src/services/llmClient.ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'   // 联合类型：只能三选一
  content: string                          // 消息内容
}
// system：设定 AI 人设（"你是搭子匹配官"）
// user：用户说的话
// assistant：AI 之前说的话（多轮对话历史）

// ─── LLMUsage：token 用量统计（用来算钱）───
// 文件路径：server/src/services/llmClient.ts
export interface LLMUsage {
  inputTokens: number    // 输入 token（用户+历史消息）= cacheHit + cacheMiss
  outputTokens: number   // 输出 token（AI 生成的）
  /** DeepSeek 硬盘缓存命中 token 数（按 ¥0.1/百万计费，节省 90%） */
  cacheHitTokens?: number
  /** DeepSeek 硬盘缓存未命中 token 数（按 ¥1.0/百万计费） */
  cacheMissTokens?: number
}

// ─── StreamCallbacks：流式回调（每来一块数据调一次）───
// 文件路径：server/src/services/llmClient.ts
export interface StreamCallbacks {
  onDelta: (text: string) => void
  /** 推理模型的思考过程（reasoning_content，DeepSeek-v4-flash 等推理模型专用） */
  onReasoning?: (text: string) => void
  onUsage?: (u: LLMUsage) => void
}
// ? 表示可选属性。onDelta 必须传，其他两个可传可不传。

// ─── ChatResult：一次对话的完整返回 ───
// 文件路径：server/src/services/llmClient.ts
export interface ChatResult {
  text: string          // AI 最终回答（content 字段累计）
  /** 推理模型的思考过程全文（若有） */
  reasoning: string     // AI 思考过程（reasoning_content 累计）
  usage: LLMUsage       // token 用量
}

// llmEnabled：是否配置了 API Key（启动时算一次，全局复用）
// config.llm.enabled 在 config/index.ts 里判断：有 key 且非占位符则为 true
export const llmEnabled = config.llm.enabled

/**
 * chatStream() — 流式对话（SSE，逐 token 推送）
 * 文件路径：server/src/services/llmClient.ts → chatStream()
 *
 * 用于：ProfileAgent.streamReplyLLM()（边生成边推给前端）
 *
 * 工作原理：
 *   1. POST 请求 DeepSeek 的 /chat/completions，stream:true
 *   2. 响应是 SSE 格式：一行一行 data: {...}
 *   3. 每来一行，解析 JSON，取 delta.content 调 onDelta
 *   4. 推理模型还有 delta.reasoning_content，调 onReasoning
 *   5. [DONE] 表示结束
 *
 * @param messages - 对话消息数组（system + history）
 * @param cb       - 回调集合（onDelta/onReasoning/onUsage）
 * @param opts     - maxTokens/temperature/signal（可中止）
 * @returns ChatResult - 累计的全文 + 用量
 *
 * @throws Error - 无 Key 或 HTTP 失败时抛错，调用方降级到模板
 */
export async function chatStream(
  messages: ChatMessage[],
  cb: StreamCallbacks,
  opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
): Promise<ChatResult> {
  if (!llmEnabled) {
    throw new Error('LLM 未配置 API Key')   // 无 Key 直接抛，调用方走降级
  }

  // 拼接 API URL：去掉末尾斜杠再拼 /chat/completions
  const url = `${config.llm.apiBase.replace(/\/$/, '')}/chat/completions`

  // 发起 POST 请求（Node 18+ 全局 fetch）
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llm.apiKey}`,   // Bearer token 鉴权
    },
    body: JSON.stringify({
      model: config.llm.model,                          // 'deepseek-v4-flash'
      messages,                                         // 对话历史
      max_tokens: opts.maxTokens ?? 1024,               // ?? 空值合并：没传就用 1024
      temperature: opts.temperature ?? 0.6,             // 温度：越高越随机
      stream: true,                                     // 关键：开启流式
      stream_options: { include_usage: true },          // 流式也返回用量统计
    }),
    signal: opts.signal,                                // 支持中止（用户关闭页面）
  })

  if (!resp.ok || !resp.body) {
    throw new Error(`LLM 请求失败: ${resp.status}`)
  }

  // ── SSE 流解析（核心难点）──
  const reader = resp.body.getReader()   // 拿到流的读取器
  const decoder = new TextDecoder()       // 字节 → 字符串
  let buf = ''                            // 缓冲区：跨块的不完整行暂存这里
  let full = ''                           // 累计正文
  let reasoning = ''                      // 累计思考过程
  let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 }

  while (true) {
    const { done, value } = await reader.read()   // 读一块
    if (done) break                                // 流结束

    buf += decoder.decode(value, { stream: true }) // 字节解码追加到缓冲
    // 按 \n 分行（SSE 协议：每行一个 data:）
    const lines = buf.split('\n')
    buf = lines.pop() || ''                        // 最后一行可能不完整，留到下次

    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue         // 非 data 行跳过（如空行/event 行）
      const data = t.slice(5).trim()               // 去掉 'data:' 前缀
      if (data === '[DONE]') continue              // 结束标记

      try {
        const json = JSON.parse(data)              // 解析这一块的 JSON
        const choice = json.choices?.[0]           // ?. 可选链：choices 为空不报错
        const delta = choice?.delta?.content       // 正文增量
        if (delta) {
          full += delta
          cb.onDelta(delta)                        // 推给上层（最终到前端 SSE）
        }
        // ── 推理模型专用：reasoning_content（思考过程）──
        const reasoningDelta = choice?.delta?.reasoning_content
        if (reasoningDelta) {
          reasoning += reasoningDelta
          cb.onReasoning?.(reasoningDelta)         // 推给上层展示在"思考框"
        }
        // ── token 用量（流式最后一块才带）──
        if (json.usage) {
          usage = {
            inputTokens: json.usage.prompt_tokens || 0,
            outputTokens: json.usage.completion_tokens || 0,
            // DeepSeek 硬盘缓存字段（自动命中，无需配置）
            cacheHitTokens: json.usage.prompt_cache_hit_tokens || 0,
            cacheMissTokens: json.usage.prompt_cache_miss_tokens || 0,
          }
          cb.onUsage?.(usage)
        }
      } catch { /* skip malformed 单块解析失败跳过，不影响整体 */ }
    }
  }
  return { text: full, reasoning, usage }
}

/**
 * chatOnce() — 非流式对话（一次性返回完整结果）
 * 文件路径：server/src/services/llmClient.ts → chatOnce()
 *
 * 用于：画像抽取（extractViaLLM）、破冰话术生成（generateLLM）
 * 这些场景需要完整 JSON，不能流式
 *
 * @param messages - 对话消息
 * @param opts     - maxTokens/temperature
 * @returns ChatResult - 完整文本 + reasoning + usage
 *
 * @throws Error - 无 Key 或失败时抛错
 */
export async function chatOnce(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<ChatResult> {
  if (!llmEnabled) throw new Error('LLM 未配置 API Key')
  const url = `${config.llm.apiBase.replace(/\/$/, '')}/chat/completions`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.3,   // 抽取用低温度（更稳定）
      // 注意：没有 stream:true，一次性返回
    }),
  })
  if (!resp.ok) throw new Error(`LLM 请求失败: ${resp.status}`)
  const json: any = await resp.json()         // any：跳过类型检查（外部 JSON 不可控）

  // 非流式响应结构：choices[0].message.content
  const text = json.choices?.[0]?.message?.content || ''
  const reasoning = json.choices?.[0]?.message?.reasoning_content || ''
  const usage: LLMUsage = {
    inputTokens: json.usage?.prompt_tokens || 0,
    outputTokens: json.usage?.completion_tokens || 0,
    cacheHitTokens: json.usage?.prompt_cache_hit_tokens || 0,
    cacheMissTokens: json.usage?.prompt_cache_miss_tokens || 0,
  }
  return { text, reasoning, usage }
}
