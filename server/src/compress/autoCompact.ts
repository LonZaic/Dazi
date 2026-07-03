// ============================================================
// autoCompact.ts — 自动压缩（重型，前 N 条摘要成 1 条）
// 文件路径：server/src/compress/autoCompact.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  学习 ccm2 的 autoCompact——                                ║
// ║  ccm2 原版：触发时把前 N 条消息摘要成一条 summary 消息      ║
// ║  搭子改造：把前 N 条聊天摘要成 system 消息（带边界标记）   ║
// ║                                                            ║
// ║  ▼▼▼ 情景：50 轮对话触发 autoCompact ▼▼▼                   ║
// ║                                                            ║
// ║    原始 log（100 条，12000 token）：                        ║
// ║      [User1, AI1, ..., User50, AI50]                      ║
// ║                                                            ║
// ║    autoCompact 后：                                        ║
// ║      newPrefix = [原prefix..., Summary边界消息]            ║
// ║      newLog = [User41, AI41, ..., User50, AI50]           ║
// ║      总 token = 1500（摘要）+ 2000（最近10条）= 3500       ║
// ║      省 8500 token                                         ║
// ║                                                            ║
// ║  ▼▼▼ 注意：prefix 变了！ ▼▼▼                                ║
// ║    autoCompact 后 prefix 多了一条 Summary 消息              ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - compress/index.ts → compactLog()
//
//   它调用：
//   - ./compressTypes.js → CompactResult, CompactConfig, 工具
//   - ./boundary.js → createSummaryBoundary
//   - ./summaryGenerator.js → generateSummary（调 LLM）
// ============================================================

import type { ChatMessage } from '../services/llmClient.js'
import {
  type CompactResult,
  type CompactConfig,
  estimateTokens,
  createNoOpResult,
  computeContextUsage,
} from './compressTypes.js'
import { createSummaryBoundary } from './boundary.js'
import { generateSummary } from './summaryGenerator.js'

/**
 * shouldAutoCompact() — 判断是否需要触发 autoCompact
 * 文件路径：server/src/compress/autoCompact.ts → shouldAutoCompact()
 *
 * 触发条件（仅此一条，不再按消息条数触发）：
 *   ★ 上下文占比 ≥ 70%（优先用官方 token 数，首次 fallback 到字符估算）
 *
 * @param prefix - 不可变前缀（system + 历史 summary 边界）
 * @param log    - 可变 log（append-only 的最近对话）
 * @param config - 压缩参数
 * @param lastApiTokenCount - 上次 API 返回的真实 prompt_tokens（可选）
 */
export function shouldAutoCompact(
  prefix: readonly ChatMessage[],
  log: readonly ChatMessage[],
  config: CompactConfig,
  lastApiTokenCount?: number,
): boolean {
  // ★ 唯一触发条件：上下文占比 ≥ 70%
  const usage = computeContextUsage(prefix, log, config, lastApiTokenCount)
  return usage >= config.contextUsageThreshold
}

/**
 * autoCompactLog() — 对 log 做自动压缩（异步，因为要调 LLM 摘要）
 * 文件路径：server/src/compress/autoCompact.ts → autoCompactLog()
 *
 * @param prefix  - 原 prefix
 * @param log     - 原 log
 * @param config  - 压缩参数
 * @returns CompactResult（含新 prefix + 新 log）
 *
 * 流程：
 *   1. 切分 log：前 N 条（要摘要的）+ 后 M 条（保留的最近对话）
 *   2. 调 generateSummary 把前 N 条压缩成摘要文本
 *   3. 用 createSummaryBoundary 包成 system 消息
 *   4. 新 prefix = 原 prefix + Summary 边界消息
 *   5. 新 log = 保留的最近 M 条
 *
 * 注意：这个函数是 async（要调 LLM）
 */
export async function autoCompactLog(
  prefix: readonly ChatMessage[],
  log: readonly ChatMessage[],
  config: CompactConfig,
  lastApiTokenCount?: number,
): Promise<CompactResult> {
  // 既不到占比阈值，也不到条数阈值 → 不压缩
  if (!shouldAutoCompact(prefix, log, config, lastApiTokenCount)) {
    return createNoOpResult(prefix, log, config)
  }

  // 有官方 token 数就用官方值，否则估算
  const beforeTokens = lastApiTokenCount && lastApiTokenCount > 0
    ? lastApiTokenCount
    : estimateTokens([...prefix, ...log], config.charsPerToken)

  // ① 切分：要摘要的旧部分 + 保留的最近部分
  const keepRecent = config.autoCompactKeepRecent
  const cutoff = Math.max(0, log.length - keepRecent)
  const oldPart = log.slice(0, cutoff)         // 要摘要的
  const recentPart = log.slice(cutoff)         // 保留的

  // ② 调 LLM 生成摘要
  const summaryText = await generateSummary(oldPart)

  // ③ 包成边界消息
  const summaryMessage = createSummaryBoundary(summaryText)

  // ④ 新 prefix = 原 prefix + Summary 消息
  //   场景：[System, Summary边界消息] 作为新前缀
  //   后续对话 prefix hash 变了，但总 token 大降
  const newPrefix = [...prefix, summaryMessage]

  // ⑤ 新 log = 保留的最近 M 条
  const newLog = [...recentPart]

  const afterTokens = estimateTokens([...newPrefix, ...newLog], config.charsPerToken)

  return {
    newPrefix,
    newLog,
    strategy: 'auto',
    beforeTokens,
    afterTokens,
    savedTokens: beforeTokens - afterTokens,
    compacted: true,
    timestamp: Date.now(),
  }
}

/**
 * autoCompactIfNeeded() — 按需触发 autoCompact（条件判断 + 执行）
 * 文件路径：server/src/compress/autoCompact.ts → autoCompactIfNeeded()
 *
 * 语法糖：先判断是否需要，需要才执行
 * 不需要时返回 noOp 结果
 *
 * 场景：cacheClient 每轮对话后调一次这个，自动维护
 */
export async function autoCompactIfNeeded(
  prefix: readonly ChatMessage[],
  log: readonly ChatMessage[],
  config: CompactConfig,
  lastApiTokenCount?: number,
): Promise<CompactResult> {
  if (!shouldAutoCompact(prefix, log, config, lastApiTokenCount)) {
    return createNoOpResult(prefix, log, config)
  }
  return autoCompactLog(prefix, log, config, lastApiTokenCount)
}
