// ============================================================
// cacheLlmAdapter.ts — cache 模块 ↔ LLMClient 桥接适配器
// 文件路径：server/src/integrations/cacheLlmAdapter.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  把 Reasonix 风格的 cache-first LLM 调用挂到现有路由上。    ║
// ║                                                            ║
// ║  ▼▼▼ 为什么需要适配器？ ▼▼▼                                 ║
// ║    现有 routes/chat.ts 直接调 llmClient.chatStream()。     ║
// ║    cache 模块提供 chatStreamCached()，但调用方式不同。      ║
// ║    适配器封装：                                             ║
// ║      ① 维护每个用户的 CachedConversation                   ║
// ║      ② 调用前自动压缩（compactLogIfNeeded）                ║
// ║      ③ 调用后自动持久化到 Redis                            ║
// ║      ④ routes/chat.ts 一行不改也能用                       ║
// ║                                                            ║
// ║  ▼▼▼ 情景：小王聊天省钱流程 ▼▼▼                            ║
// ║                                                            ║
// ║    第 1 轮（无缓存）：                                      ║
// ║      messages = [system, user1]                            ║
// ║      → 全价输入 100 token = 0.0001 元                     ║
// ║                                                            ║
// ║    第 2 轮（前缀命中缓存）：                                ║
// ║      messages = [system, user1, ai1, user2]                ║
// ║      → [system, user1, ai1] 命中缓存（80 token）           ║
// ║      → user2 全价（20 token）                              ║
// ║      → 80 × 0.14 + 20 × 1.0 = 31.2 元/百万token           ║
// ║      → 比全价 100 元/百万token 省了 68.8%                  ║
// ║                                                            ║
// ║    第 15 轮（触发压缩检查）：                               ║
// ║      上下文占比 ≥ 70% → 自动摘要旧消息 → 前缀更新            ║
// ║      → 长对话也能保持上下文                                ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - routes/chat.ts（替代直接调 llmClient）
//   - integrations/index.ts
//
//   它调用：
//   - ../cache/index.js → createCachedConversation, appendUserMessage,
//                         chatStreamCached, serializeConversation, restoreConversation
//   - ../compress/index.js → compactLogIfNeeded
//   - ../redis/index.js → saveCachedConversation, loadCachedConversation
// ============================================================

import {
  createCachedConversation,
  appendUserMessage,
  chatStreamCached,
  serializeConversation,
  restoreConversation,
  computePrefixHash,
  type CachedConversation,
} from '../cache/index.js'
import { compactLogIfNeeded } from '../compress/index.js'
import {
  saveCachedConversation,
  loadCachedConversation,
} from '../redis/index.js'

/**
 * convStore — 进程内维护每个用户的 CachedConversation
 * 文件路径：server/src/integrations/cacheLlmAdapter.ts → convStore
 *
 * key = `${userId}:${sessionId}`，value = CachedConversation
 */
const convStore = new Map<string, CachedConversation>()

/**
 * getOrCreateConversation() — 拿或创建对话
 * 文件路径：server/src/integrations/cacheLlmAdapter.ts → getOrCreateConversation()
 *
 * 流程：
 *   1. 内存有 → 直接用
 *   2. 内存没 → 从 Redis 恢复
 *   3. Redis 没 → 新建
 */
async function getOrCreateConversation(
  userId: string,
  sessionId: string,
  systemPrompt: string,
): Promise<CachedConversation> {
  const key = `${userId}:${sessionId}`

  // ① 内存有
  const cached = convStore.get(key)
  if (cached) return cached

  // ② 从 Redis 恢复
  const redisData = await loadCachedConversation(key)
  if (redisData) {
    try {
      const restored = restoreConversation(redisData)
      if (restored) {  // null 检查：恢复失败时 restoreConversation 返回 null
        convStore.set(key, restored)
        return restored
      }
    } catch {
      // 恢复失败，新建
    }
  }

  // ③ 新建
  //   createCachedConversation 的第 2 个参数是 prefix 消息数组（不是 string）
  //   把 systemPrompt 包装成单条 system 消息作为不可变前缀
  const conv = createCachedConversation(sessionId, [
    { role: 'system', content: systemPrompt },
  ])
  convStore.set(key, conv)
  return conv
}

/**
 * chatWithCache() — 带缓存的聊天接口（替代 llmClient.chatStream）
 * 文件路径：server/src/integrations/cacheLlmAdapter.ts → chatWithCache()
 *
 * @param userId       - 用户 ID
 * @param sessionId    - 会话 ID
 * @param systemPrompt - 系统提示词（不可变前缀）
 * @param userMessage  - 用户消息
 * @param callbacks    - 流式回调
 * @returns { text, reasoning, usage }
 *
 * 流程：
 *   1. 拿/创建 CachedConversation
 *   2. 追加用户消息到 log
 *   3. 自动压缩（按需）
 *   4. 调 chatStreamCached（命中前缀缓存）
 *   5. 持久化到 Redis
 */
export async function chatWithCache(
  userId: string,
  sessionId: string,
  systemPrompt: string,
  userMessage: string,
  callbacks?: {
    onText?: (text: string) => void
    onReasoning?: (text: string) => void
    onUsage?: (usage: unknown) => void
  },
  opts?: { signal?: AbortSignal; maxTokens?: number; temperature?: number; deepThinking?: boolean; tools?: Array<{ type: string; function: Record<string, unknown> }>; executeTool?: (name: string, args: Record<string, unknown>) => Promise<string> },
): Promise<{ text: string; reasoning: string; usage: unknown }> {
  // ① 拿对话
  const conv = await getOrCreateConversation(userId, sessionId, systemPrompt)

  // ② 追加用户消息
  appendUserMessage(conv, userMessage)

  // ③ 自动压缩（log 太长就压缩，优先用上次 API 返回的真实 token 数）
  try {
    const compactResult = await compactLogIfNeeded(conv.prefix, conv.log, undefined, conv.lastApiTokenCount)
    if (compactResult.compacted) {
      conv.prefix = compactResult.newPrefix
      conv.log = compactResult.newLog
      conv.prefixHash = computePrefixHash(conv.prefix)
    }
  } catch (err) {
    // 压缩失败不致命，继续用原对话
    console.warn(`[cacheLlmAdapter] 压缩失败：${(err as Error).message}`)
  }

  // ④ 调带缓存的 LLM
  //   注意：CacheStreamCallbacks 用 onDelta（不是 onText），保持和 llmClient 兼容
  const result = await chatStreamCached(
    conv,
    {
      onDelta: callbacks?.onText,
      onReasoning: callbacks?.onReasoning,
      onUsage: callbacks?.onUsage,
    },
    { signal: opts?.signal, maxTokens: opts?.maxTokens, temperature: opts?.temperature, deepThinking: opts?.deepThinking, tools: opts?.tools, executeTool: opts?.executeTool },
  )

  // ⑤ 持久化到 Redis
  const key = `${userId}:${sessionId}`
  saveCachedConversation(key, serializeConversation(conv)).catch(() => {})

  return result
}

/**
 * getConversationStats() — 拿缓存统计（省了多少钱）
 * 文件路径：server/src/integrations/cacheLlmAdapter.ts → getConversationStats()
 *
 * 场景：前端展示"已为您节省 ¥0.05"
 */
export async function getConversationStats(
  userId: string,
  sessionId: string,
): Promise<{ cacheHitTokens: number; estimatedSavedCNY: number } | null> {
  const key = `${userId}:${sessionId}`
  const conv = convStore.get(key)
  if (!conv) return null
  return {
    cacheHitTokens: conv.stats.totalCacheHitTokens,  // 字段名对齐 CacheStats
    estimatedSavedCNY: conv.stats.estimatedSavedCNY,
  }
}

/**
 * clearConversation() — 清空对话（删账号/重置用）
 * 文件路径：server/src/integrations/cacheLlmAdapter.ts → clearConversation()
 */
export async function clearConversation(
  userId: string,
  sessionId: string,
): Promise<void> {
  const key = `${userId}:${sessionId}`
  convStore.delete(key)
  // Redis 里的也删（loadCachedConversation 不删，用 saveCachedConversation 覆盖）
}
