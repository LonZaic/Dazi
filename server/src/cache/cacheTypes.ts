// ============================================================
// cacheTypes.ts — Reasonix 缓存前置方案的类型契约
// 文件路径：server/src/cache/cacheTypes.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件定义 Reasonix 风格 cache-first LLM 的核心数据结构。 ║
// ║                                                            ║
// ║  ▼▼▼ Reasonix 省钱策略的 3 个核心概念 ▼▼▼                  ║
// ║                                                            ║
// ║  ① Immutable Prefix（不可变前缀）                           ║
// ║     - System prompt + few-shot 例子 + 早期对话              ║
// ║     - 一旦写入绝不修改（连一个字都不改）                    ║
// ║     - DeepSeek 用这个做"字节级前缀匹配"，命中就 0.1 元/百万  ║
// ║       （正常 input 是 1 元/百万，省 90%）                   ║
// ║                                                            ║
// ║  ② Append-Only Log（只追加日志）                            ║
// ║     - 新的 user/assistant 消息只追加到末尾                  ║
// ║     - 绝不修改、删除、重排已有消息                          ║
// ║     - 这样前缀哈希永远稳定，缓存命中率最大化                 ║
// ║                                                            ║
// ║  ③ Volatile Scratch（易失草稿区）                           ║
// ║     - 工具调用结果、临时思考笔记等"用完即弃"的内容           ║
// ║     - 每轮对话结束后清空，下一轮重新生成                    ║
// ║     - 不计入前缀哈希（因为它们会变）                        ║
// ║                                                            ║
// ║  ▼▼▼ 情景：小王第 3 轮对话怎么走缓存 ▼▼▼                   ║
// ║                                                            ║
// ║    第 1 轮：[System][User1]                                ║
// ║      → 前缀 = System + User1，缓存 miss，全价计费          ║
// ║      → DeepSeek 把这个前缀"指纹"记下来                     ║
// ║                                                            ║
// ║    第 2 轮：[System][User1][AI1][User2]                    ║
// ║      → 前缀 = System + User1 + AI1 + User2                 ║
// ║      → DeepSeek 发现 System+User1+AI1 部分命中缓存         ║
// ║      → 只为 User2 部分付全价，前面付 0.1 倍价               ║
// ║                                                            ║
// ║    第 3 轮：[System][User1][AI1][User2][AI2][User3]        ║
// ║      → 前 5 条全部命中缓存，只为 User3 付全价               ║
// ║      → 聊得越久省得越多（前缀越长越省）                    ║
// ║                                                            ║
// ║  ▼▼▼ 为啥不能用 LangChain？ ▼▼▼                            ║
// ║    LangChain 每轮都"重新组装"prompt（加 timestamp、        ║
// ║    动态变量等），导致前缀每轮都变，缓存永远 miss。           ║
// ║    所以这里完全手写，保证前缀稳定。                          ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   老链路（Dazi 已有）：
//     chat.ts → llmClient.chatStream(messages, cb) → DeepSeek
//
//   新链路（零侵入，可选启用）：
//     chat.ts → cacheClient.chatStreamCached(conv, cb)
//                  │
//                  ▼
//                检查 prefix hash 是否稳定
//                  │
//                  ▼
//                拼 messages = prefix + log + scratch
//                  │
//                  ▼
//                llmClient.chatStream(messages, cb) → DeepSeek
//                  │
//                  ▼
//                收 usage.prompt_cache_hit_tokens → 记 stats
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - cache/prefixHash.ts（用 CacheStats 类型）
//   - cache/appendLog.ts（用 MessageRole, AppendOnlyLog）
//   - cache/cacheClient.ts（用所有类型）
//   - cache/cacheStats.ts（用 CacheStats）
//   - integrations/llmClientCacheAdapter.ts（用 CachedConversation）
//
//   它调用：无（纯类型定义）
// ============================================================

// ─── 复用 Dazi 已有的 ChatMessage 类型（避免重复定义）───
// 文件路径：server/src/cache/cacheTypes.ts
//   ChatMessage 已经在 services/llmClient.ts 里定义，
//   这里 re-export 让 cache 模块自洽，外部 import 一处即可
//   注意：re-export 不会让本文件内可见，必须再 import type 一次
import type { ChatMessage } from '../services/llmClient.js'
export type { ChatMessage } from '../services/llmClient.js'

// ════════════════════════════════════════════════════════════
//  【类型 1】MessageRole — 消息角色字面量
// ════════════════════════════════════════════════════════════
//   DeepSeek/OpenAI 标准三角色：system / user / assistant
//   注意：和 ChatMessage.role 保持一致（不带 tool，因为
//   tool 结果会作为 user 消息回填，不直接用 tool 角色）
export type MessageRole = 'system' | 'user' | 'assistant'

// ════════════════════════════════════════════════════════════
//  【类型 2】PrefixHash — 前缀指纹（SHA-256 截断）
// ════════════════════════════════════════════════════════════
//   用途：检测前缀是否被修改（修改了 hash 就变，缓存必 miss）
//   格式：'sha256:' + 16 字符 hex（截断够用，碰撞概率极低）
//   例：'sha256:a3f1b2c4d5e6f789'
export type PrefixHash = string

// ════════════════════════════════════════════════════════════
//  【类型 3】CacheStats — 缓存命中统计（监控省钱效果）
// ════════════════════════════════════════════════════════════
//   每轮对话后从 DeepSeek 响应里抽 usage 字段，记到这里
//   场景：dashboard 显示"已省 ¥12.3"就是基于这个算的
export interface CacheStats {
  /** 总请求数（包括 miss 的） */
  totalRequests: number
  /** 总输入 token（包括命中和未命中） */
  totalInputTokens: number
  /** 命中缓存的 token 数（按 0.1 倍价计费） */
  totalCacheHitTokens: number
  /** 未命中的 token 数（按全价计费） */
  totalCacheMissTokens: number
  /** 估算省下的钱（元，按 DeepSeek 定价 input 1元/百万 token） */
  estimatedSavedCNY: number
  /** 缓存命中率（0-1，hit / (hit + miss)） */
  hitRate: number
  /** 最近一次更新的时间戳 */
  updatedAt: number
}

// ════════════════════════════════════════════════════════════
//  【类型 4】CachedConversation — 一个会话的完整缓存视图
// ════════════════════════════════════════════════════════════
//   这是 cache 模块对外的主打数据结构
//   一个用户会话对应一个 CachedConversation 实例
//   3 个分区：prefix（不可变）+ log（只追加）+ scratch（每轮清）
export interface CachedConversation {
  /** 会话 ID（用户 ID + 会话 ID 拼接，唯一标识） */
  conversationId: string
  /** 不可变前缀（system + few-shot + 早期固定对话） */
  prefix: readonly ChatMessage[]
  /** 前缀的 SHA-256 指纹（前缀变就重新算） */
  prefixHash: PrefixHash
  /** 只追加日志（user/assistant 轮流追加，绝不修改） */
  log: ChatMessage[]
  /** 易失草稿区（工具结果、临时笔记，每轮清空） */
  scratch: ChatMessage[]
  /** 该会话的累计缓存统计 */
  stats: CacheStats
  /** 上次 API 返回的真实 input token 数（prefix+log+scratch 总和，来自 DeepSeek usage.prompt_tokens） */
  lastApiTokenCount: number
  /** 创建时间 */
  createdAt: number
  /** 最后更新时间 */
  updatedAt: number
}

// ════════════════════════════════════════════════════════════
//  【类型 5】CacheStreamCallbacks — 流式回调（和 llmClient 一致）
// ════════════════════════════════════════════════════════════
//   保持和 llmClient.StreamCallbacks 兼容，方便无缝替换
export interface CacheStreamCallbacks {
  /** 收到正文增量 */
  onDelta?: (text: string) => void
  /** 收到推理增量（DeepSeek-R1 的 reasoning_content） */
  onReasoning?: (text: string) => void
  /** 收到 usage（含 cache_hit_tokens） */
  onUsage?: (usage: CacheUsagePayload) => void
  /** 流结束 */
  onDone?: (fullText: string, reasoning: string) => void
  /** 出错 */
  onError?: (err: Error) => void
}

// ════════════════════════════════════════════════════════════
//  【类型 6】CacheUsagePayload — DeepSeek 返回的 usage（带缓存字段）
// ════════════════════════════════════════════════════════════
//   DeepSeek 在响应里返回 prompt_cache_hit_tokens（命中缓存的 token 数）
//   这是判断"省了多少"的关键字段
export interface CacheUsagePayload {
  /** 输入 token 总数 */
  promptTokens: number
  /** 输出 token 总数 */
  completionTokens: number
  /** 命中缓存的 token 数（DeepSeek 特有字段） */
  promptCacheHitTokens?: number
  /** 命中缓存外的 token 数（= promptTokens - cacheHit） */
  promptCacheMissTokens?: number
}

// ════════════════════════════════════════════════════════════
//  【常量 1】CACHE_CONFIG — 缓存模块参数（可调）
// ════════════════════════════════════════════════════════════
//   调这里就能改"省钱激进程度"和"草稿区上限"
export const CACHE_CONFIG = {
  /** 草稿区最多保留几条（避免膨胀） */
  maxScratchMessages: 6,
  /** 日志最多保留几条（超过就触发压缩，压缩走 compress 模块） */
  maxLogMessages: 30,
  /** 缓存命中的单价倍率（DeepSeek 是 0.14 元/百万 token，全价是 1 元） */
  cacheHitPriceMultiplier: 0.14,
  /** 全价输入单价（元/百万 token，DeepSeek-Chat 定价） */
  fullInputPricePerMillion: 1.0,
  /** 前缀哈希长度（截断 SHA-256 到多少 hex 字符） */
  prefixHashLength: 16,
} as const

// ════════════════════════════════════════════════════════════
//  【工具函数】createEmptyCacheStats — 造一个空统计对象
// ════════════════════════════════════════════════════════════
//   场景：新建会话时初始化 stats
export function createEmptyCacheStats(): CacheStats {
  return {
    totalRequests: 0,
    totalInputTokens: 0,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    estimatedSavedCNY: 0,
    hitRate: 0,
    updatedAt: Date.now(),
  }
}
