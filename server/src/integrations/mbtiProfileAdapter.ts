// ============================================================
// mbtiProfileAdapter.ts — MBTI 模块 ↔ ProfileAgent 桥接适配器
// 文件路径：server/src/integrations/mbtiProfileAdapter.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  把 mbti/ 模块挂到 ProfileAgent 上，零侵入。               ║
// ║                                                            ║
// ║  ▼▼▼ 为什么需要适配器？ ▼▼▼                                 ║
// ║    ProfileAgent 已有 extractProfile() 返回 ProfilePatch。  ║
// ║    MBTI 模块有 extractMbtiSignals() 返回 MbtiDimensionSignal[]║
// ║    两者返回类型不同、调用方式不同。                         ║
// ║    适配器负责：                                            ║
// ║      ① 调 MBTI 抽取 → 把 signals 合并到现有画像            ║
// ║      ② 把 MBTI 画像写入 MemoryBus Layer 2                  ║
// ║      ③ 不改 profileAgent.ts 一行代码                       ║
// ║                                                            ║
// ║  ▼▼▼ 情景：小王聊天 → MBTI 画像增量演化 ▼▼▼                ║
// ║                                                            ║
// ║    第 1 轮："我喜欢一个人看书"                              ║
// ║      MBTI 抽取 → [I 0.6, N 0.5]（偏内向、偏直觉）          ║
// ║      mbtiProfile = {type:'UNKNOWN', confidence:0.3, ...}   ║
// ║                                                            ║
// ║    第 5 轮："我觉得长远规划很重要"                          ║
// ║      MBTI 抽取 → [J 0.7, N 0.6]（偏判断、偏直觉）          ║
// ║      applyDimensionPatch 合并 →                            ║
// ║      mbtiProfile = {type:'INFJ', confidence:0.65, ...}     ║
// ║                                                            ║
// ║    第 10 轮：mbtiProfile.type='INFJ', confidence=0.85      ║
// ║      → 写入 MemoryBus Layer 2                              ║
// ║      → MatchAgent 匹配时拿这个做 MBTI 兼容度计算           ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - routes/chat.ts（在调 profileAgent 后调本适配器）
//   - integrations/index.ts（统一导出）
//
//   它调用：
//   - ../mbti/index.js → extractMbtiSignals, applyDimensionPatch
//   - ../memory/index.js → globalMemoryBus
//   - ../services/llmClient.js → ChatMessage 类型
// ============================================================

import {
  extractMbtiSignals,
  applyDimensionPatch,
  type MbtiProfile,
  type MbtiDimensionSignal,
} from '../mbti/index.js'
import { globalMemoryBus } from '../memory/index.js'
import type { ChatMessage } from '../services/llmClient.js'

/**
 * mbtiState — 进程内维护每个用户的当前 MBTI 画像
 * 文件路径：server/src/integrations/mbtiProfileAdapter.ts → mbtiState
 *
 * 用 Map<userId, MbtiProfile> 存
 * 每轮对话后增量更新（applyDimensionPatch 合并新信号）
 *
 * 注意：重启后从 MemoryBus Layer 2 恢复（mbti 字段）
 */
const mbtiState = new Map<string, MbtiProfile>()

/**
 * getMbtiProfile() — 拿用户当前 MBTI 画像
 * 文件路径：server/src/integrations/mbtiProfileAdapter.ts → getMbtiProfile()
 *
 * 优先级：
 *   1. 内存 mbtiState
 *   2. MemoryBus Layer 2（其他进程可能更新过）
 */
export function getMbtiProfile(userId: string): MbtiProfile {
  const cached = mbtiState.get(userId)
  if (cached) return cached

  // 从 MemoryBus 恢复
  const entry = globalMemoryBus.readLongTermProfile('profile', userId)
  if (entry?.payload.mbti) {
    mbtiState.set(userId, entry.payload.mbti)
    return entry.payload.mbti
  }

  // 全没有 → 返回空画像
  return {
    type: 'UNKNOWN',
    confidence: 0,
    dimensions: [],
    updatedAt: Date.now(),
  }
}

/**
 * updateMbtiFromMessages() — 从对话抽 MBTI 信号 + 增量更新画像
 * 文件路径：server/src/integrations/mbtiProfileAdapter.ts → updateMbtiFromMessages()
 *
 * @param userId    - 用户 ID
 * @param messages  - 当前对话消息
 * @returns 更新后的 MBTI 画像
 *
 * 调用链：
 *   extractMbtiSignals(messages)    → 抽出 signals
 *   applyDimensionPatch(old, signals) → 合并到现有画像
 *   globalMemoryBus.updateLongTermProfile() → 写入 Layer 2
 *
 * 场景：routes/chat.ts 每轮对话后调
 *   const mbti = await updateMbtiFromMessages(userId, messages)
 */
export async function updateMbtiFromMessages(
  userId: string,
  messages: readonly ChatMessage[],
): Promise<MbtiProfile> {
  // ① 抽 MBTI 信号
  let signals: MbtiDimensionSignal[] = []
  try {
    signals = await extractMbtiSignals(messages)
  } catch (err) {
    // 抽取失败不致命，保持原画像
    console.warn(`[mbtiProfileAdapter] 抽取失败：${(err as Error).message}`)
    return getMbtiProfile(userId)
  }

  if (signals.length === 0) {
    return getMbtiProfile(userId)
  }

  // ② 增量合并到现有画像
  const current = getMbtiProfile(userId)
  const updated = applyDimensionPatch(current, signals)

  // ③ 缓存到内存
  mbtiState.set(userId, updated)

  // ④ 写入 MemoryBus Layer 2（让 MatchAgent 也能读到）
  try {
    globalMemoryBus.updateLongTermProfile('profile', userId, [], updated)
  } catch (err) {
    // 写 MemoryBus 失败不致命（内存里还有）
    console.warn(`[mbtiProfileAdapter] 写 MemoryBus 失败：${(err as Error).message}`)
  }

  return updated
}

/**
 * resetMbtiProfile() — 重置用户 MBTI 画像（删账号/调试用）
 * 文件路径：server/src/integrations/mbtiProfileAdapter.ts → resetMbtiProfile()
 */
export function resetMbtiProfile(userId: string): void {
  mbtiState.delete(userId)
}
