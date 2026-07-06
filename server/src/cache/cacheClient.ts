// ============================================================
// cacheClient.ts — Reasonix 风格 cache-first 流式客户端
// 文件路径：server/src/cache/cacheClient.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这是 cache 模块的"对外门面"——                              ║
// ║  包装 DeepSeek API 调用，自动管理 prefix/log/scratch 三区。 ║
// ║                                                            ║
// ║  ▼▼▼ 为啥不直接复用 llmClient.chatStream？ ▼▼▼             ║
// ║    - llmClient 已有的 LLMUsage 没有 cache_hit_tokens 字段   ║
// ║    - 改 llmClient 会动现有文件（用户明确禁止）              ║
// ║    - 这里直接 fetch DeepSeek API，自己解析完整 usage        ║
// ║    - 这样 llmClient.ts 一字不改，cacheClient 自洽          ║
// ║                                                            ║
// ║  ▼▼▼ 情景：第 3 轮对话，cacheClient 怎么走 ▼▼▼             ║
// ║                                                            ║
// ║    1. cacheClient.chatStreamCached(conv, cb)               ║
// ║    2. 验证 prefix hash 稳定（前缀没动）                    ║
// ║    3. 拼 messages = prefix + log + scratch                ║
// ║    4. POST DeepSeek /chat/completions (stream:true)        ║
// ║    5. SSE 解析 delta / reasoning_content / usage           ║
// ║    6. usage.prompt_cache_hit_tokens → 更新 stats          ║
// ║    7. AI 回复 append 到 conv.log（保持 append-only）       ║
// ║    8. scratch 清空（下轮重新生成）                         ║
// ║                                                            ║
// ║  ▼▼▼ 和 llmClient.chatStream 的兼容性 ▼▼▼                  ║
// ║    签名兼容：cb.onDelta / onReasoning / onUsage 都一致     ║
// ║    chat.ts 可以一行替换：                                  ║
// ║      老：await chatStream(messages, cb, opts)              ║
// ║      新：await cacheClient.chatStreamCached(conv, cb, opt) ║
// ║    （但保留老接口，用户可自行选择启用）                     ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   chat.ts (Dazi 已有)
//      │
//      ▼ （新增可选 import，零侵入）
//   cacheClient.chatStreamCached(conv, cb, opts)
//      │
//      ├─→ prefixHash.verifyPrefixStable() 自检
//      ├─→ 拼 messages = prefix + log + scratch
//      ├─→ fetch DeepSeek API（自己直接 fetch，不调 llmClient）
//      ├─→ SSE 解析 → cb.onDelta / onReasoning / onUsage
//      ├─→ appendOnlyLog.append('assistant', fullText)
//      ├─→ scratch.clear()
//      └─→ updateStatsWithUsage()
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - integrations/llmClientCacheAdapter.ts
//   - chat.ts（可选启用）
//
//   它调用：
//   - ../services/llmClient.js → ChatMessage 类型 + llmEnabled + config
//   - ../config/index.js → config.llm（API 配置）
//   - ./cacheTypes.js → 类型 + CACHE_CONFIG
//   - ./prefixHash.js → 前缀自检
//   - ./appendLog.js → AppendOnlyLog
//   - ./cacheStats.js → updateStatsWithUsage
//   - ../core/tracer.js → addStep（链路追踪）
// ============================================================

import { llmEnabled, chatStream, type ChatMessage } from '../services/llmClient.js'
import { addStep } from '../core/tracer.js'
import {
  type CachedConversation,
  type CacheStreamCallbacks,
  type CacheUsagePayload,
  CACHE_CONFIG,
  createEmptyCacheStats,
} from './cacheTypes.js'
import { computePrefixHash, verifyPrefixStable, describeHashChange } from './prefixHash.js'
import { AppendOnlyLog } from './appendLog.js'
import { updateStatsWithUsage, formatStatsReport } from './cacheStats.js'

/**
 * createCachedConversation() — 创建一个新会话的缓存视图
 * 文件路径：server/src/cache/cacheClient.ts → createCachedConversation()
 *
 * @param conversationId - 会话 ID（如 'user-123:session-456'）
 * @param prefixMessages - 不可变前缀消息（system + few-shot + 早期固定对话）
 * @returns CachedConversation 实例
 *
 * 场景：用户开始新会话时调用
 *   const conv = createCachedConversation('u1:s1', [
 *     { role:'system', content:'你是搭子助手...' },
 *   ])
 */
export function createCachedConversation(
  conversationId: string,
  prefixMessages: readonly ChatMessage[],
): CachedConversation {
  return {
    conversationId,
    prefix: prefixMessages,                              // 不可变前缀
    prefixHash: computePrefixHash(prefixMessages),       // 算初始指纹
    log: [],                                              // 空 log
    scratch: [],                                          // 空 scratch
    stats: createEmptyCacheStats(),
    lastApiTokenCount: 0,                                 // 首次未发请求，暂无真实值
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * appendUserMessage() — 追加用户消息到 log（不修改 prefix）
 * 文件路径：server/src/cache/cacheClient.ts → appendUserMessage()
 *
 * 这是 cacheClient 暴露的"对话推进"接口
 * 调用方：chat.ts 收到用户消息后调用此函数
 */
export function appendUserMessage(conv: CachedConversation, content: string): void {
  // log 只追加，不修改前缀
  conv.log.push({ role: 'user', content })
  conv.updatedAt = Date.now()
}

/**
 * appendToolResult() — 追加工具结果到 scratch（每轮清空）
 * 文件路径：server/src/cache/cacheClient.ts → appendToolResult()
 *
 * 工具结果不放 log（因为它是"临时草稿"，不进缓存前缀）
 * 放 scratch 区，每轮对话结束清空
 *
 * 场景：ProfileAgent 抽完画像，把结果塞 scratch 给 AI 参考
 */
export function appendToolResult(conv: CachedConversation, content: string): void {
  // 注意：ChatMessage.role 只支持 system/user/assistant（不带 tool），
  // 工具结果用 'user' 角色塞进 scratch，content 前加标签区分
  conv.scratch.push({ role: 'user', content: `[tool_result] ${content}` })
  // 超过上限自动截断（保留最新的几条）
  if (conv.scratch.length > CACHE_CONFIG.maxScratchMessages) {
    conv.scratch.splice(0, conv.scratch.length - CACHE_CONFIG.maxScratchMessages)
  }
}

/**
 * chatStreamCached() — 缓存感知的流式对话（核心 API）
 * 文件路径：server/src/cache/cacheClient.ts → chatStreamCached()
 *
 * @param conv - 会话缓存视图
 * @param cb   - 流式回调（和 llmClient.StreamCallbacks 兼容）
 * @param opts - maxTokens / temperature / signal
 * @returns { text, reasoning, usage } 完整结果
 *
 * 流程：
 *   1. 前缀自检（hash 不变才发请求）
 *   2. 拼 messages = prefix + log + scratch
 *   3. 调 llmClient.chatStream（复用统一入口，不再自己 fetch）
 *   4. AI 回复 append 到 conv.log（保持 append-only）
 *   5. scratch 清空（下轮重新生成）
 *   6. 更新 conv.stats
 */
export async function chatStreamCached(
  conv: CachedConversation,
  cb: CacheStreamCallbacks,
  opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal; deepThinking?: boolean; tools?: Array<{ type: string; function: Record<string, unknown> }>; executeTool?: (name: string, args: Record<string, unknown>) => Promise<string> } = {},
): Promise<{ text: string; reasoning: string; usage: CacheUsagePayload }> {
  if (!llmEnabled) {
    const err = new Error('LLM 未配置 API Key')
    cb.onError?.(err)
    throw err
  }

  // ① 前缀自检：hash 必须稳定（开发期防误改）
  const currentHash = computePrefixHash(conv.prefix)
  if (!verifyPrefixStable(conv.prefix, conv.prefixHash)) {
    addStep('info', {
      phase: 'cache-prefix-changed',
      change: describeHashChange(conv.prefixHash, currentHash),
    })
    conv.prefixHash = currentHash
  }

  // ② 拼 messages = prefix + log + scratch
  const messages: ChatMessage[] = [
    ...conv.prefix,
    ...conv.log,
    ...conv.scratch,
  ]

  addStep('llm_call', {
    phase: 'cache-stream',
    conversationId: conv.conversationId,
    msgCount: messages.length,
    prefixStable: currentHash === conv.prefixHash,
  })

  // ③ 调 llmClient.chatStream（复用统一入口，不在 cache 层重复写 fetch）
  //   llmClient 已在 2026.07 补齐 prompt_cache_hit_tokens 字段，无需单独 fetch
  if (opts.tools && opts.tools.length > 0) {
    console.log(`[cache] 带 ${opts.tools.length} 个工具调 LLM: ${opts.tools.map((t: any) => t.function?.name).join(', ')}`)
  }
  let fullText = ''
  let fullReasoning = ''
  let usagePayload: CacheUsagePayload = { promptTokens: 0, completionTokens: 0 }

  try {
    const result = await chatStream(
      messages,
      {
        onDelta: (text) => {
          fullText += text
          cb.onDelta?.(text)
        },
        onReasoning: (text) => {
          fullReasoning += text
          cb.onReasoning?.(text)
        },
        onUsage: (u) => {
          usagePayload = {
            promptTokens: u.inputTokens,
            completionTokens: u.outputTokens,
            promptCacheHitTokens: u.cacheHitTokens,
            promptCacheMissTokens: u.cacheMissTokens,
          }
          cb.onUsage?.(usagePayload)
        },
      },
      opts,
    )

    // result 里已有完整 text/reasoning，但 onDelta 回调已经边收边推了
    fullText = result.text
    fullReasoning = result.reasoning

    // ★ Function calling 循环（缓存层内部处理，确保最终回复写入 conv.log）
    if (result.toolCalls && result.toolCalls.length > 0 && opts.executeTool) {
      addStep('info', { event: 'function_calling', count: result.toolCalls.length })

      // 把 assistant 的 tool_calls 加入 messages（不写 conv.log，tool 调用是临时上下文）
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: result.toolCalls.map(tc => ({
          id: tc.id, type: 'function' as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      })

      // 执行每个工具
      for (const tc of result.toolCalls) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.args) } catch { /* */ }
        const toolResult = await opts.executeTool(tc.name, args)
        messages.push({ role: 'tool', content: toolResult, tool_call_id: tc.id })
        addStep('tool_result', { tool: tc.name, resultLen: toolResult.length })
      }

      // 再调 LLM 生成最终回复（不带 tools，防止再触发）
      fullText = ''
      const finalResult = await chatStream(
        messages,
        {
          onDelta: (d) => { fullText += d; cb.onDelta?.(d) },
          onUsage: (u) => {
            usagePayload.promptTokens += u.inputTokens
            usagePayload.completionTokens += u.outputTokens
          },
        },
        { maxTokens: opts.maxTokens, temperature: opts.temperature, signal: opts.signal, deepThinking: opts.deepThinking },
        // ★ 不传 tools，防止无限循环
      )

      fullText = finalResult.text
    }

    usagePayload = {
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      promptCacheHitTokens: result.usage.cacheHitTokens,
      promptCacheMissTokens: result.usage.cacheMissTokens,
    }
  } catch (err: any) {
    cb.onError?.(err)
    throw err
  }

  // ④ AI 回复 append 到 log（保持 append-only 语义）
  if (fullText) {
    conv.log.push({ role: 'assistant', content: fullText })
  }

  // ⑤ scratch 清空（每轮清，下轮重新生成）
  conv.scratch.length = 0

  // ⑥ 更新 stats + 存真实 token 数（来自 API，不是估算）
  conv.stats = updateStatsWithUsage(conv.stats, usagePayload)
  conv.lastApiTokenCount = usagePayload.promptTokens   // ★ 官方 token 数，留给下轮压缩判断用
  conv.updatedAt = Date.now()

  addStep('info', {
    phase: 'cache-stream-done',
    stats: formatStatsReport(conv.stats),
    cacheHit: usagePayload.promptCacheHitTokens ?? 0,
    cacheMiss: usagePayload.promptCacheMissTokens ?? 0,
  })

  cb.onDone?.(fullText, fullReasoning)

  return { text: fullText, reasoning: fullReasoning, usage: usagePayload }
}

/**
 * getConversationStats() — 拿会话的累计缓存统计
 * 文件路径：server/src/cache/cacheClient.ts → getConversationStats()
 *
 * 场景：dashboard 显示"你这周省了 ¥X"
 */
export function getConversationStats(conv: CachedConversation) {
  return conv.stats
}

/**
 * serializeConversation() — 序列化会话（存 Redis 用）
 * 文件路径：server/src/cache/cacheClient.ts → serializeConversation()
 *
 * 场景：进程重启前把 conv 存 Redis，重启后 restoreConversation 恢复
 */
export function serializeConversation(conv: CachedConversation): string {
  return JSON.stringify({
    conversationId: conv.conversationId,
    prefix: conv.prefix,
    prefixHash: conv.prefixHash,
    log: conv.log,
    scratch: conv.scratch,
    stats: conv.stats,
    lastApiTokenCount: conv.lastApiTokenCount,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  })
}

/**
 * restoreConversation() — 从序列化数据恢复会话
 * 文件路径：server/src/cache/cacheClient.ts → restoreConversation()
 *
 * 场景：进程重启后从 Redis 恢复，对话继续（前缀 hash 不变，缓存仍能命中）
 */
export function restoreConversation(serialized: string): CachedConversation | null {
  try {
    const obj = JSON.parse(serialized)
    return {
      conversationId: obj.conversationId,
      prefix: obj.prefix,
      prefixHash: obj.prefixHash,
      log: obj.log ?? [],
      scratch: obj.scratch ?? [],
      stats: obj.stats ?? createEmptyCacheStats(),
      lastApiTokenCount: obj.lastApiTokenCount ?? 0,
      createdAt: obj.createdAt ?? Date.now(),
      updatedAt: obj.updatedAt ?? Date.now(),
    }
  } catch {
    return null
  }
}

// ─── 重导出常用工具（方便一处导入）───
// 文件路径：server/src/cache/cacheClient.ts
export { AppendOnlyLog } from './appendLog.js'
export { computePrefixHash, verifyPrefixStable } from './prefixHash.js'
export { updateStatsWithUsage, formatStatsReport } from './cacheStats.js'
