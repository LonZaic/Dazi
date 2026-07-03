// ============================================================
// cacheStats.ts — 缓存命中统计（监控省钱效果）
// 文件路径：server/src/cache/cacheStats.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件记录"缓存命中省了多少钱"——                          ║
// ║  每轮对话结束后从 DeepSeek 响应里抽 usage 字段，记到这里。   ║
// ║                                                            ║
// ║  ▼▼▼ 为啥要单独统计？ ▼▼▼                                   ║
// ║  - 老板要看的："用了 1 周，省了 ¥X，命中率 Y%"              ║
// ║  - 调参依据：命中率低于 50% 说明前缀老在变，要排查          ║
// ║  - 多实例聚合：多个进程的 stats 汇总到 Redis，全局看效果    ║
// ║                                                            ║
// ║  ▼▼▼ 情景：第 3 轮对话，stats 怎么更新 ▼▼▼                  ║
// ║                                                            ║
// ║    第 1 轮：                                                ║
// ║      prompt_tokens=100, cache_hit_tokens=0                 ║
// ║      → totalRequests=1, totalInputTokens=100               ║
// ║      → totalCacheHitTokens=0, totalCacheMissTokens=100     ║
// ║      → estimatedSavedCNY=0（没省）                          ║
// ║                                                            ║
// ║    第 2 轮：                                                ║
// ║      prompt_tokens=200, cache_hit_tokens=100               ║
// ║      → totalRequests=2, totalInputTokens=300               ║
// ║      → totalCacheHitTokens=100, totalCacheMissTokens=200   ║
// ║      → estimatedSavedCNY = 100 × (1-0.14) × 1 / 1e6        ║
// ║                          = 0.000086 元                     ║
// ║      → hitRate = 100/300 = 33%                             ║
// ║                                                            ║
// ║    第 10 轮：                                               ║
// ║      prompt_tokens=1000, cache_hit_tokens=950              ║
// ║      → hitRate = 95%，单轮省 9.5 倍价差                    ║
// ║      → 累计省 ¥0.85（小数累计）                             ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【定价说明（DeepSeek-Chat 2024 定价）】
// ════════════════════════════════════════════════════════════
//   - input（未命中缓存）：1 元 / 百万 token
//   - input（命中缓存）：0.1 元 / 百万 token（省 90%）
//   - output：2 元 / 百万 token
//   - 这里的省额只算 input 部分（output 没法缓存）
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - cache/cacheClient.ts（每轮对话后 update）
//   - integrations/llmClientCacheAdapter.ts（查询 stats 显示）
//   - redis/ 模块（多实例聚合时序列化 stats）
//
//   它调用：
//   - ./cacheTypes.js → CacheStats, CacheUsagePayload, CACHE_CONFIG
// ============================================================

import {
  type CacheStats,
  type CacheUsagePayload,
  CACHE_CONFIG,
  createEmptyCacheStats,
} from './cacheTypes.js'

/**
 * updateStatsWithUsage() — 用一次 LLM 调用的 usage 更新累计统计
 * 文件路径：server/src/cache/cacheStats.ts → updateStatsWithUsage()
 *
 * @param current  - 当前累计统计（会被函数返回新值，不改入参）
 * @param usage    - DeepSeek 返回的 usage（含 prompt_cache_hit_tokens）
 * @returns 更新后的新统计对象（纯函数，不改入参）
 *
 * 场景：cacheClient.chatStreamCached() 完成后调用此函数
 */
export function updateStatsWithUsage(
  current: CacheStats,
  usage: CacheUsagePayload,
): CacheStats {
  const hit = usage.promptCacheHitTokens ?? 0
  // miss = 总 input - hit（DeepSeek 不一定返回 miss 字段，自己算）
  const miss = usage.promptCacheMissTokens ?? Math.max(0, usage.promptTokens - hit)

  // 累加
  const totalRequests = current.totalRequests + 1
  const totalInputTokens = current.totalInputTokens + usage.promptTokens
  const totalCacheHitTokens = current.totalCacheHitTokens + hit
  const totalCacheMissTokens = current.totalCacheMissTokens + miss

  // 省的钱（元）
  //   命中部分原本要付 fullInputPrice，现在付 fullInputPrice × cacheHitPriceMultiplier
  //   省 = hit × (fullInputPrice - fullInputPrice × multiplier) / 1e6
  //      = hit × fullInputPrice × (1 - multiplier) / 1e6
  const estimatedSavedCNY = round6(
    current.estimatedSavedCNY +
    hit * CACHE_CONFIG.fullInputPricePerMillion * (1 - CACHE_CONFIG.cacheHitPriceMultiplier) / 1e6
  )

  // 命中率
  const hitRate = totalInputTokens > 0
    ? round4(totalCacheHitTokens / totalInputTokens)
    : 0

  return {
    totalRequests,
    totalInputTokens,
    totalCacheHitTokens,
    totalCacheMissTokens,
    estimatedSavedCNY,
    hitRate,
    updatedAt: Date.now(),
  }
}

/**
 * formatStatsReport() — 把 stats 格式化成可读字符串（日志/前端展示用）
 * 文件路径：server/src/cache/cacheStats.ts → formatStatsReport()
 *
 * 场景：dashboard 显示
 *   "缓存命中：95.2%（共 1234 次请求，省 ¥0.85）"
 */
export function formatStatsReport(stats: CacheStats): string {
  const hitPercent = (stats.hitRate * 100).toFixed(1)
  const savedYuan = stats.estimatedSavedCNY.toFixed(4)
  return `缓存命中：${hitPercent}%（共 ${stats.totalRequests} 次请求，省 ¥${savedYuan}）`
}

// ─── 内部工具：精度控制 ───
// 文件路径：server/src/cache/cacheStats.ts

/** 四舍五入到 6 位小数（金额，避免浮点精度） */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

/** 四舍五入到 4 位小数（比率） */
function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4
}
