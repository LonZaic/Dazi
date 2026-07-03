// ============================================================
// index.ts — compress 模块统一出口（barrel file）
// 文件路径：server/src/compress/index.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  compress 模块对外门面——学习 ccm2 的压缩策略。              ║
// ║                                                            ║
// ║  模块职责总览（"压缩学习 E:\ccm2，结合场景改造"）：          ║
// ║                                                            ║
// ║  ┌─────────────────────────────────────────────────────┐ ║
// ║  │  compressTypes.ts    类型 + DEFAULT_COMPACT_CONFIG  │ ║
// ║  │  boundary.ts         边界标记（包摘要的 system 消息）│ ║
// ║  │  summaryGenerator.ts LLM 摘要生成（调 DeepSeek）    │ ║
// ║  │  autoCompact.ts      重型自动压缩（前 N 条→1 条摘要）│ ║
// ║  └─────────────────────────────────────────────────────┘ ║
// ║                                                            ║
// ║  对外典型用法：                                            ║
// ║                                                            ║
// ║  ① 每轮对话后自动检查+压缩：                                ║
// ║     const result = await compactLogIfNeeded(prefix, log)   │ ║
// ║     if (result.compacted) {                                │ ║
// ║       conv.prefix = result.newPrefix                       │ ║
// ║       conv.log = result.newLog                             │ ║
// ║       conv.prefixHash = computePrefixHash(result.newPrefix)│ ║
// ║     }                                                      │ ║
// ║                                                            ║
// ║  ② 查压缩效果：                                            ║
// ║     console.log(`省了 ${result.savedTokens} token`)        │ ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

// ─── 类型导出 ───
export type {
  CompactStrategy,
  CompactResult,
  CompactConfig,
} from './compressTypes.js'

// ─── 常量 + 工具函数导出 ───
export {
  DEFAULT_COMPACT_CONFIG,
  estimateTokens,
  createNoOpResult,
  computeContextUsage,
} from './compressTypes.js'

// ─── 边界标记 ───
export {
  BOUNDARY_PREFIX,
  BOUNDARY_SUFFIX,
  createSummaryBoundary,
  isSummaryBoundary,
  extractSummaryText,
} from './boundary.js'

// ─── 自动压缩 ───
export {
  shouldAutoCompact,
  autoCompactLog,
  autoCompactIfNeeded,
} from './autoCompact.js'

// ─── 摘要生成 ───
export { generateSummary } from './summaryGenerator.js'

// ─── 统一入口：按需压缩 ───
// 文件路径：server/src/compress/index.ts → compactLogIfNeeded()
import { type CompactResult, type CompactConfig, DEFAULT_COMPACT_CONFIG, createNoOpResult, computeContextUsage } from './compressTypes.js'
import { shouldAutoCompact, autoCompactLog } from './autoCompact.js'
import type { ChatMessage } from '../services/llmClient.js'

/**
 * compactLogIfNeeded() — 统一入口：按需压缩
 * 文件路径：server/src/compress/index.ts → compactLogIfNeeded()
 *
 * 触发条件：
 *   上下文占比 ≥ 70% → autoCompact（LLM 摘要，prefix 变，缓存重置）
 *
 * @param prefix  - 原 prefix（不可变前缀）
 * @param log     - 原 log（可变 log）
 * @param config  - 压缩参数（可选）
 * @param lastApiTokenCount - 上次 API 返回的真实 prompt_tokens（可选）
 * @returns CompactResult
 */
export async function compactLogIfNeeded(
  prefix: readonly ChatMessage[],
  log: readonly ChatMessage[],
  config: CompactConfig = DEFAULT_COMPACT_CONFIG,
  lastApiTokenCount?: number,
): Promise<CompactResult> {
  // 上下文占比 ≥ 70% → autoCompact（LLM 摘要，prefix 变，缓存重置）
  if (shouldAutoCompact(prefix, log, config, lastApiTokenCount)) {
    return autoCompactLog(prefix, log, config, lastApiTokenCount)
  }

  // 不压缩
  return createNoOpResult(prefix, log, config)
}

/**
 * getContextUsage() — 对外暴露的占比查询（前端可展示"上下文已用 X%"）
 * 文件路径：server/src/compress/index.ts → getContextUsage()
 */
export function getContextUsage(
  prefix: readonly ChatMessage[],
  log: readonly ChatMessage[],
  config: CompactConfig = DEFAULT_COMPACT_CONFIG,
  lastApiTokenCount?: number,
): number {
  return computeContextUsage(prefix, log, config, lastApiTokenCount)
}
