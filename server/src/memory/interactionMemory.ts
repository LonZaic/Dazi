// ============================================================
// interactionMemory.ts — Layer 4 撮合交互记忆
// 文件路径：server/src/memory/interactionMemory.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  Layer 4：IceBreakerAgent 读写，存破冰话术历史。            ║
// ║                                                            ║
// ║  ▼▼▼ 为什么需要这一层？ ▼▼▼                                 ║
// ║    - 避免重复话题：上次用了"跑步"开场，这次别再用           ║
// ║    - 优化破冰策略：发现"兴趣开场"效果好，下次多用           ║
// ║    - 个性化话术：根据历史效果为每对用户定制                ║
// ║                                                            ║
// ║  ▼▼▼ 情景：小王被撮合过几次 ▼▼▼                            ║
// ║                                                            ║
// ║    entries = [                                             ║
// ║      {peerId:'小李', iceBreakerType:'兴趣开场',              ║
// ║       iceBreakerText:'你俩都喜欢跑步，一起晨跑？',          ║
// ║       topicsUsed:['跑步','晨跑'], effect:1, T-3天},         ║
// ║                                                            ║
// ║      {peerId:'小张', iceBreakerType:'情境问句',              ║
// ║       iceBreakerText:'你们都在北京，周末有空吗？',          ║
// ║       topicsUsed:['北京','周末'], effect:0, T-1天},         ║
// ║    ]                                                       ║
// ║                                                            ║
// ║    IceBreakerAgent 下次撮合小王+小赵时：                   ║
// ║      ① 读 Layer 4 → 发现"跑步""晨跑""北京""周末"用过       ║
// ║      ② 找新话题（从 Layer 2 画像找没聊过的兴趣）            ║
// ║      ③ 发现"兴趣开场"effect=1（好），"情境问句"effect=0（一般）║
// ║      ④ 优先用"兴趣开场"+新话题（如"读书"）                 ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - memory/memoryBus.ts
//   - integrations/agentMemoryAdapter.ts（IceBreakerAgent 包装）
//
//   它调用：
//   - ./memoryTypes.js → InteractionEntry, MEMORY_CONFIG
// ============================================================

import {
  type InteractionEntry,
  MEMORY_CONFIG,
} from './memoryTypes.js'

/**
 * InteractionMemory — Layer 4 撮合交互记忆实现
 * 文件路径：server/src/memory/interactionMemory.ts → class InteractionMemory
 *
 * 用 Map<userId, InteractionEntry[]> 存储
 * 每个用户对应多条交互记录（按时间倒序）
 */
export class InteractionMemory {
  private readonly _store = new Map<string, InteractionEntry[]>()

  /**
   * write() — 记录一次破冰交互
   * 文件路径：server/src/memory/interactionMemory.ts → InteractionMemory.write()
   */
  write(userId: string, entry: InteractionEntry): void {
    const list = this._store.get(userId) ?? []
    list.unshift(entry)
    this._store.set(userId, list)
  }

  /**
   * getUsedTopics() — 拿用户被用过的话题（去重用）
   * 文件路径：server/src/memory/interactionMemory.ts → InteractionMemory.getUsedTopics()
   *
   * @param userId - 用户 ID
   * @param window - 时间窗口（默认 interactionTopicDedup）
   * @returns 话题字符串数组
   *
   * 场景：IceBreakerAgent 撮合时排除这些话题
   */
  getUsedTopics(
    userId: string,
    window: number = MEMORY_CONFIG.interactionTopicDedup,
  ): string[] {
    const list = this._store.get(userId) ?? []
    const recent = list.slice(0, window)

    // 聚合所有 topicsUsed，去重
    const topics = new Set<string>()
    for (const e of recent) {
      for (const t of e.payload.topicsUsed) {
        topics.add(t)
      }
    }
    return Array.from(topics)
  }

  /**
   * getIceBreakerEffectStats() — 拿话术类型效果统计（策略优化用）
   * 文件路径：server/src/memory/interactionMemory.ts → InteractionMemory.getIceBreakerEffectStats()
   *
   * @param userId - 用户 ID
   * @returns 各话术类型的平均效果分（-1 到 1）
   *
   * 场景：IceBreakerAgent 决定下次用哪种话术
   *   "兴趣开场" 平均效果 0.7 → 优先用
   *   "情境问句" 平均效果 0.1 → 少用
   */
  getIceBreakerEffectStats(userId: string): Record<string, number> {
    const list = this._store.get(userId) ?? []
    if (list.length === 0) return {}

    const byType = new Map<string, number[]>()
    for (const e of list) {
      const type = e.payload.iceBreakerType
      const arr = byType.get(type) ?? []
      arr.push(e.payload.effect)
      byType.set(type, arr)
    }

    const stats: Record<string, number> = {}
    for (const [type, effects] of byType) {
      const avg = effects.reduce((s, x) => s + x, 0) / effects.length
      stats[type] = Math.round(avg * 100) / 100
    }
    return stats
  }

  /**
   * getHistoryWithPeer() — 拿和某人的交互历史
   * 文件路径：server/src/memory/interactionMemory.ts → InteractionMemory.getHistoryWithPeer()
   *
   * 场景：小王和小李被撮合过 2 次，看历史话术效果
   */
  getHistoryWithPeer(userId: string, peerId: string): InteractionEntry[] {
    const list = this._store.get(userId) ?? []
    return list.filter(e => e.payload.peerId === peerId)
  }

  /**
   * read() — 读用户所有交互记录
   */
  read(userId: string): InteractionEntry[] {
    return this._store.get(userId) ?? []
  }

  /**
   * serialize() / restore() — 序列化/反序列化
   */
  serialize(): string {
    return JSON.stringify(Array.from(this._store.entries()))
  }

  restore(serialized: string): void {
    try {
      const arr = JSON.parse(serialized) as [string, InteractionEntry[]][]
      this._store.clear()
      for (const [k, v] of arr) this._store.set(k, v)
    } catch {
      // 恢复失败忽略
    }
  }
}
