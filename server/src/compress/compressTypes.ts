// ============================================================
// compressTypes.ts — 压缩模块类型契约（学习 ccm2，适配聊天场景）
// 文件路径：server/src/compress/compressTypes.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件定义"对话压缩"的数据结构——                          ║
// ║  学习 ccm2（Claude Code 源码）的压缩策略，适配搭子聊天场景。 ║
// ║                                                            ║
// ║  ▼▼▼ 为啥要压缩？ ▼▼▼                                       ║
// ║    - 用户聊了 50 轮，log 里有 100 条消息，token 10000+     ║
// ║    - 每轮都把全历史发 DeepSeek，token 费爆炸                ║
// ║    - 即使有缓存，output 还是按全价算                        ║
// ║    - 压缩 = 把旧消息变短，新消息保持完整                    ║
// ║                                                            ║
// ║  ▼▼▼ ccm2 的压缩策略（学习+改造）▼▼▼                       ║
// ║                                                            ║
// ║  autoCompact（重型自动压缩）                                 ║
// ║     - ccm2 原版：触发时把前 N 条消息摘要成一条 summary      ║
// ║     - 搭子改造：把前 N 条聊天摘要成"会话摘要"消息           ║
// ║     - 适用：上下文占比 ≥ 70%，必须减重                      ║
// ║     - 改对话结构（前 N 条变 1 条摘要）                      ║
// ║     - 注意：摘要后 prefix hash 变了，缓存重新累积           ║
// ║                                                            ║
// ║  ▼▼▼ 情景：上下文到 70% 怎么压缩 ▼▼▼                        ║
// ║                                                            ║
// ║    聊天聊了很多轮，上下文占比到 70%（~45K token）：           ║
// ║      [System, User1, AI1, ..., User50, AI50]              ║
// ║      总 token ≈ 45000                                     ║
// ║                                                            ║
// ║    autoCompact 后：                                        ║
// ║      [System, Summary(前40轮), User41, AI41, ..., AI50]   ║
// ║      总 token ≈ 1500（摘要）+ 7000（最近10轮）= 8500       ║
// ║      省了 80% token                                        ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【和 cache 模块的协作】
// ════════════════════════════════════════════════════════════
//   - cache 模块的 AppendOnlyLog.shouldCompact() 触发压缩
//   - compress 模块产出新的 prefix（含摘要）+ 新 log（剩余消息）
//   - cache 模块用新 prefix 重新算 hash，后续对话基于新前缀缓存
//   - 一次压缩 = 一次 prefix 重置（缓存重新累积，但总 token 大降）
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - integrations/llmClientCacheAdapter.ts（log 超阈值时触发）
//   - cache/cacheClient.ts（shouldCompact 时调）
//
//   它调用：无（纯类型定义）
// ============================================================

import type { ChatMessage } from '../services/llmClient.js'

// ════════════════════════════════════════════════════════════
//  【类型 1】CompactStrategy — 压缩策略枚举
// ════════════════════════════════════════════════════════════
export type CompactStrategy = 'auto' | 'none'
//   auto：重型压缩（前 N 条摘要成 1 条 summary）
//   none：不压缩

// ════════════════════════════════════════════════════════════
//  【类型 2】CompactResult — 一次压缩的结果
// ════════════════════════════════════════════════════════════
export interface CompactResult {
  /** 压缩后的新前缀（原 prefix + summary 消息） */
  newPrefix: ChatMessage[]
  /** 压缩后的新 log（保留的最近几轮对话） */
  newLog: ChatMessage[]
  /** 用的压缩策略 */
  strategy: CompactStrategy
  /** 压缩前的估算 token 数 */
  beforeTokens: number
  /** 压缩后的估算 token 数 */
  afterTokens: number
  /** 省下的 token 数（before - after） */
  savedTokens: number
  /** 是否实际触发了压缩（false 表示不需要压缩） */
  compacted: boolean
  /** 压缩发生的时间戳 */
  timestamp: number
}

// ════════════════════════════════════════════════════════════
//  【类型 3】CompactConfig — 压缩参数（可调）
// ════════════════════════════════════════════════════════════
export interface CompactConfig {
  /** 触发 autoCompact 的消息条数阈值（默认 30） */
  autoCompactThreshold: number
  /** autoCompact 时保留最近几轮对话不压缩（默认 10 条 = 5 轮）*/
  autoCompactKeepRecent: number
  /** 估算 token 用的系数（1 token ≈ 多少字符，中文约 1.5）*/
  charsPerToken: number
  /**
   * 上下文窗口最大 token 数（DeepSeek V3 = 64K，V4 = 128K）
   * 用于"占比阈值"判断（95% 触发 autoCompact）
   */
  contextWindowTokens: number
  /**
   * 上下文占比阈值（0~1，默认 0.70）
   * 当 (prefix + log) 的估算 token / contextWindowTokens ≥ 此值 → 触发 autoCompact
   */
  contextUsageThreshold: number
}

// ════════════════════════════════════════════════════════════
//  【常量 1】DEFAULT_COMPACT_CONFIG — 默认压缩参数
// ════════════════════════════════════════════════════════════
//   调这里就能改"压缩激进程度"
export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  autoCompactThreshold: 30,    // 已废弃：不再按条数触发 autoCompact
  autoCompactKeepRecent: 10,   // 保留最近 10 条（5 轮）
  charsPerToken: 1.5,          // 中文 1 token ≈ 1.5 字符（仅首轮 fallback）
  contextWindowTokens: 64_000, // DeepSeek V3 默认 64K 上下文窗口
  contextUsageThreshold: 0.70, // ★ autoCompact 触发：上下文占比 ≥ 70%
} as const

// ════════════════════════════════════════════════════════════
//  【工具函数】estimateTokens — 估算消息数组的 token 数（仅阈值用，非计费）
// ════════════════════════════════════════════════════════════
//   ⚠️ 注意：这个估算只用于"决定要不要触发压缩"的阈值判断，
//           不用于计费！
//   真实 token 数由 DeepSeek 官方 API 返回（usage.prompt_tokens /
//   usage.completion_tokens / usage.prompt_cache_hit_tokens），
//   见 cache/cacheStats.ts → updateStatsWithUsage()
//
//   场景：compactLogIfNeeded() 用这个粗略估算，避免每轮都调 API
export function estimateTokens(messages: readonly ChatMessage[], charsPerToken = 1.5): number {
  return Math.ceil(
    messages.reduce((s, m) => s + m.content.length, 0) / charsPerToken
  )
}

// ════════════════════════════════════════════════════════════
//  【工具函数】createNoOpResult — 造一个"未压缩"的结果
// ════════════════════════════════════════════════════════════
//   场景：消息不够多，不需要压缩，返回这个表示"啥也没做"
export function createNoOpResult(
  prefix: readonly ChatMessage[],
  log: readonly ChatMessage[],
  config: CompactConfig,
): CompactResult {
  const tokens = estimateTokens([...prefix, ...log], config.charsPerToken)
  return {
    newPrefix: [...prefix],
    newLog: [...log],
    strategy: 'none',
    beforeTokens: tokens,
    afterTokens: tokens,
    savedTokens: 0,
    compacted: false,
    timestamp: Date.now(),
  }
}

// ════════════════════════════════════════════════════════════
//  【工具函数】computeContextUsage — 上下文窗口占比（0~1）
// ════════════════════════════════════════════════════════════
//   场景：判断是否到 95% 触发压缩
//   返回值：0.0 ~ 1.0+（可能超过 1，表示已经爆窗口）
//
//   ★ 优先用官方 API 返回的真实 token 数（lastApiTokenCount）
//     首次调用 fallback 到字符估算
export function computeContextUsage(
  prefix: readonly ChatMessage[],
  log: readonly ChatMessage[],
  config: CompactConfig,
  lastApiTokenCount?: number,
): number {
  // ★ 有官方 token 数就直接用（来自 DeepSeek usage.prompt_tokens）
  //   增量部分（最新 1-2 条消息）用字符估算，误差极小（几十 token）
  if (lastApiTokenCount && lastApiTokenCount > 0) {
    return lastApiTokenCount / config.contextWindowTokens
  }
  // 首次：fallback 到字符估算
  const total = estimateTokens([...prefix, ...log], config.charsPerToken)
  return total / config.contextWindowTokens
}
