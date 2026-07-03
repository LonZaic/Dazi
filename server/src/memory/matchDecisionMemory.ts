// ============================================================
// matchDecisionMemory.ts — Layer 3 匹配决策记忆
// 文件路径：server/src/memory/matchDecisionMemory.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  Layer 3：MatchAgent 读写，存匹配对+维度得分+反馈。         ║
// ║                                                            ║
// ║  ▼▼▼ 为什么需要这一层？ ▼▼▼                                 ║
// ║    - 去重：上周推过小李，这周别再推（用户烦）              ║
// ║    - 权重迭代：用户对"兴趣标签"反馈好，下次权重提高        ║
// ║    - 可解释：用户问"为啥推他"，能溯源到具体标签贡献        ║
// ║                                                            ║
// ║  ▼▼▼ 情景：小王被推荐过哪些候选 ▼▼▼                        ║
// ║                                                            ║
// ║    entries = [                                             ║
// ║      {candidateId:'小李', overallScore:0.78,                ║
// ║       dimensionScores:{vector:0.85, interest:0.9, mbti:0.7},║
// ║       tagTrace:[{tag:'跑步',contribution:0.3},              ║
// ║                 {tag:'INFJ',contribution:0.2}],            ║
// ║       userFeedback:-1, recommendedAt:T-3天},               ║
// ║                                                            ║
// ║      {candidateId:'小张', overallScore:0.82,                ║
// ║       dimensionScores:{vector:0.7, interest:0.85, mbti:0.9},║
// ║       tagTrace:[{tag:'夜跑',contribution:0.35}],            ║
// ║       userFeedback:1, recommendedAt:T-1天},                ║
// ║    ]                                                       ║
// ║                                                            ║
// ║    MatchAgent 下次匹配时：                                 ║
// ║      ① 读 Layer 3 → 发现小李推过且反馈=-1 → 排除           ║
// ║      ② 发现小张推过且反馈=1 → 也排除（已成功）             ║
// ║      ③ 发现"mbti"维度反馈好 → 下次权重 0.2 → 0.25          ║
// ║                                                            ║
// ║  ▼▼▼ 权重迭代怎么做？ ▼▼▼                                  ║
// ║    每 N 次反馈后，统计各维度的"反馈加权得分"：              ║
// ║      interest 平均反馈 = (1+(-1)+1+0)/4 = 0.25             ║
// ║      mbti 平均反馈 = (1+1+1+1)/4 = 1.0                    ║
// ║    → mbti 维度反馈好 → 权重 0.2 → 0.3                     ║
// ║    → interest 维度反馈一般 → 权重 0.3 → 0.25               ║
// ║    （这是 MatchAgent 内部逻辑，本层只提供数据）            ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - memory/memoryBus.ts
//   - integrations/agentMemoryAdapter.ts（MatchAgent 包装）
//
//   它调用：
//   - ./memoryTypes.js → MatchDecisionEntry, MEMORY_CONFIG
// ============================================================

import {
  type MatchDecisionEntry,
  MEMORY_CONFIG,
} from './memoryTypes.js'

/**
 * MatchDecisionMemory — Layer 3 匹配决策记忆实现
 * 文件路径：server/src/memory/matchDecisionMemory.ts → class MatchDecisionMemory
 *
 * 用 Map<userId, MatchDecisionEntry[]> 存储
 * 每个用户对应多条匹配决策记录（按时间倒序）
 */
export class MatchDecisionMemory {
  private readonly _store = new Map<string, MatchDecisionEntry[]>()

  /**
   * write() — 记录一次匹配决策
   * 文件路径：server/src/memory/matchDecisionMemory.ts → MatchDecisionMemory.write()
   *
   * @param userId  - 被推荐的用户 ID
   * @param entry   - 匹配决策条目
   */
  write(userId: string, entry: MatchDecisionEntry): void {
    const list = this._store.get(userId) ?? []
    // 插入到列表开头（新的在前）
    list.unshift(entry)
    this._store.set(userId, list)
  }

  /**
   * updateFeedback() — 更新某次推荐的反馈
   * 文件路径：server/src/memory/matchDecisionMemory.ts → MatchDecisionMemory.updateFeedback()
   *
   * @param userId     - 被推荐的用户 ID
   * @param candidateId - 候选用户 ID
   * @param feedback   - 反馈（1=感兴趣, 0=中立, -1=不感兴趣）
   * @returns 是否更新成功
   *
   * 场景：小王点了"不感兴趣"按钮 → feedback=-1
   */
  updateFeedback(
    userId: string,
    candidateId: string,
    feedback: 1 | 0 | -1,
  ): boolean {
    const list = this._store.get(userId)
    if (!list) return false

    // 找最近一次该候选的推荐记录（可能推过多次，取最近的）
    const entry = list.find(e => e.payload.candidateId === candidateId)
    if (!entry) return false

    entry.payload.userFeedback = feedback
    entry.timestamp = Date.now()
    return true
  }

  /**
   * getRecentCandidates() — 拿最近推荐过的候选（去重用）
   * 文件路径：server/src/memory/matchDecisionMemory.ts → MatchDecisionMemory.getRecentCandidates()
   *
   * @param userId - 被推荐的用户 ID
   * @param window - 时间窗口（最近 N 条，默认 matchDedupWindow）
   * @returns 候选 ID 列表
   *
   * 场景：MatchAgent 匹配时排除这些候选（避免重复推荐）
   */
  getRecentCandidates(
    userId: string,
    window: number = MEMORY_CONFIG.matchDedupWindow,
  ): string[] {
    const list = this._store.get(userId) ?? []
    return list.slice(0, window).map(e => e.payload.candidateId)
  }

  /**
   * getFeedbackStats() — 拿维度反馈统计（权重迭代用）
   * 文件路径：server/src/memory/matchDecisionMemory.ts → MatchDecisionMemory.getFeedbackStats()
   *
   * @param userId - 用户 ID
   * @returns 各维度的平均反馈分（-1 到 1）
   *
   * 场景：MatchAgent 调这个调整维度权重
   *   "mbti 维度反馈平均 0.8 → 权重提高"
   *   "interest 维度反馈平均 -0.2 → 权重降低"
   */
  getFeedbackStats(userId: string): Record<string, number> {
    const list = this._store.get(userId) ?? []
    const withFeedback = list.filter(e => e.payload.userFeedback !== undefined)
    if (withFeedback.length === 0) return {}

    const dims = ['vector', 'interest', 'style', 'schedule', 'goal', 'mbti']
    const stats: Record<string, number> = {}

    for (const dim of dims) {
      const scores = withFeedback
        .filter(e => e.payload.dimensionScores[dim as keyof typeof e.payload.dimensionScores] !== undefined)
        .map(e => ({
          score: e.payload.dimensionScores[dim as keyof typeof e.payload.dimensionScores] as number,
          feedback: e.payload.userFeedback as number,
        }))

      if (scores.length === 0) continue

      // 加权平均：feedback 为正表示该维度有效，为负表示无效
      // 统计 = Σ(score × feedback) / Σ(|feedback|)
      let weighted = 0
      let totalWeight = 0
      for (const s of scores) {
        weighted += s.score * s.feedback
        totalWeight += Math.abs(s.feedback)
      }
      stats[dim] = totalWeight > 0
        ? Math.round(weighted / totalWeight * 100) / 100
        : 0
    }

    return stats
  }

  /**
   * read() — 读用户的所有匹配决策记录
   */
  read(userId: string): MatchDecisionEntry[] {
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
      const arr = JSON.parse(serialized) as [string, MatchDecisionEntry[]][]
      this._store.clear()
      for (const [k, v] of arr) this._store.set(k, v)
    } catch {
      // 恢复失败忽略
    }
  }
}
