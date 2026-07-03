// ============================================================
// agentMemoryAdapter.ts — 3 个 Agent ↔ MemoryBus 桥接适配器
// 文件路径：server/src/integrations/agentMemoryAdapter.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  把 3 个 Agent 挂到 MemoryBus 上，零侵入。                 ║
// ║                                                            ║
// ║  ▼▼▼ 为什么需要适配器？ ▼▼▼                                 ║
// ║    现有 Agent 文件不直接调 MemoryBus（避免循环依赖）。      ║
// ║    适配器在外层包一层：                                     ║
// ║      Agent 输出 → 适配器 → MemoryBus                       ║
// ║      MemoryBus → 适配器 → Agent 输入                       ║
// ║    → Agent 文件一行不动                                    ║
// ║                                                            ║
// ║  ▼▼▼ 情景：3 Agent 各自怎么用 MemoryBus ▼▼▼                ║
// ║                                                            ║
// ║    ProfileAgent：                                          ║
// ║      ① 每轮 appendShortTerm(userId, sid, msg)              ║
// ║      ② 抽完画像 → updateLongTermProfile(tags)              ║
// ║      ③ 会话结束 → settleSession(sid) → 沉淀到 Layer 2      ║
// ║                                                            ║
// ║    MatchAgent：                                            ║
// ║      ① readLongTermProfile(userId) → 拿画像                ║
// ║      ② searchByVector(vec) → 拿候选                        ║
// ║      ③ getRecentCandidates(userId) → 排除已推荐             ║
// ║      ④ writeMatchDecision(entry) → 存决策                  ║
// ║                                                            ║
// ║    IceBreakerAgent：                                       ║
// ║      ① readLongTermProfile(userA/B) → 拿双方画像           ║
// ║      ② getUsedTopics(userId) → 排除用过的话题              ║
// ║      ③ writeInteraction(entry) → 存破冰结果                ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - routes/chat.ts（ProfileAgent 相关调用）
//   - routes/match.ts（MatchAgent 相关调用）
//   - routes/icebreaker.ts（IceBreakerAgent 相关调用）
//
//   它调用：
//   - ../memory/index.js → globalMemoryBus
//   - ../agents/profileAgent.js → ProfilePatch 类型（仅类型）
// ============================================================

import { globalMemoryBus } from '../memory/index.js'
import type {
  ProfileTag,
  MatchDecisionEntry,
  InteractionEntry,
} from '../memory/index.js'
import type { ChatMessage } from '../services/llmClient.js'

// ════════════════════════════════════════════════════════════
//  ProfileAgent 适配器
// ════════════════════════════════════════════════════════════

/**
 * profileAdapter — ProfileAgent 用 MemoryBus 的桥接
 * 文件路径：server/src/integrations/agentMemoryAdapter.ts → profileAdapter
 */
export const profileAdapter = {
  /**
   * onMessage() — 每轮对话后调
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → profileAdapter.onMessage()
   *
   * 把消息追加到 Layer 1（短期会话记忆）
   *
   * @param userId    - 用户 ID
   * @param sessionId - 会话 ID
   * @param role      - 消息角色（'user' / 'assistant'）
   * @param content   - 消息内容
   */
  onMessage(
    userId: string,
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
  ): void {
    if (!content || content.trim().length === 0) return
    globalMemoryBus.appendShortTerm('profile', userId, sessionId, { role, content })
  },

  /**
   * onProfileExtracted() — ProfileAgent 抽完画像后调
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → profileAdapter.onProfileExtracted()
   *
   * 把 ProfilePatch 转成 ProfileTag[] 写入 Layer 2
   *
   * @param userId - 用户 ID
   * @param patch  - ProfileAgent 输出的 patch
   */
  onProfileExtracted(
    userId: string,
    patch: {
      interests?: { name: string; confidence?: number; evidence?: string | string[] }[]
      socialStyle?: { energy?: string; depth?: string }
      goal?: string
      constraints?: string[]
    },
  ): void {
    const tags: ProfileTag[] = []
    const now = Date.now()

    // 兴趣 → interest 类标签
    if (patch.interests) {
      for (const i of patch.interests) {
        tags.push({
          category: 'interest',
          name: i.name,
          value: '喜欢',
          confidence: i.confidence ?? 0.5,
          evidence: typeof i.evidence === 'string' ? [i.evidence] : (i.evidence ?? []),
          updatedAt: now,
        })
      }
    }

    // 社交风格 → social 类标签
    if (patch.socialStyle?.energy) {
      tags.push({
        category: 'social',
        name: '能量方向',
        value: patch.socialStyle.energy,
        confidence: 0.7,
        evidence: [],
        updatedAt: now,
      })
    }
    if (patch.socialStyle?.depth) {
      tags.push({
        category: 'social',
        name: '社交深度',
        value: patch.socialStyle.depth,
        confidence: 0.7,
        evidence: [],
        updatedAt: now,
      })
    }

    // 目标 → attribute 类标签
    if (patch.goal) {
      tags.push({
        category: 'attribute',
        name: '找搭子目标',
        value: patch.goal,
        confidence: 0.8,
        evidence: [patch.goal],
        updatedAt: now,
      })
    }

    // 约束 → redline 类标签
    if (patch.constraints) {
      for (const c of patch.constraints) {
        tags.push({
          category: 'redline',
          name: '限制条件',
          value: c,
          confidence: 0.6,
          evidence: [c],
          updatedAt: now,
        })
      }
    }

    if (tags.length > 0) {
      globalMemoryBus.updateLongTermProfile('profile', userId, tags)
    }
  },

  /**
   * onSessionEnd() — 会话结束调
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → profileAdapter.onSessionEnd()
   *
   * 把 Layer 1 的会话消息沉淀到 Layer 2
   */
  onSessionEnd(userId: string, sessionId: string): void {
    globalMemoryBus.settleSession(userId, sessionId)
  },
}

// ════════════════════════════════════════════════════════════
//  MatchAgent 适配器
// ════════════════════════════════════════════════════════════

/**
 * matchAdapter — MatchAgent 用 MemoryBus 的桥接
 * 文件路径：server/src/integrations/agentMemoryAdapter.ts → matchAdapter
 */
export const matchAdapter = {
  /**
   * getUserProfile() — 拿用户长期画像
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → matchAdapter.getUserProfile()
   */
  getUserProfile(userId: string) {
    return globalMemoryBus.readLongTermProfile('match', userId)
  },

  /**
   * getExcludedCandidates() — 拿已推荐过的候选（去重）
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → matchAdapter.getExcludedCandidates()
   */
  getExcludedCandidates(userId: string): string[] {
    return globalMemoryBus.getRecentCandidates('match', userId)
  },

  /**
   * recordMatch() — 记录一次匹配决策
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → matchAdapter.recordMatch()
   *
   * @param userId       - 被推荐的用户
   * @param candidateId  - 候选用户
   * @param overallScore - 综合得分
   * @param dimensionScores - 维度得分
   * @param tagTrace     - 标签溯源
   */
  recordMatch(
    userId: string,
    candidateId: string,
    overallScore: number,
    dimensionScores: MatchDecisionEntry['payload']['dimensionScores'],
    tagTrace: { tag: string; contribution: number }[],
  ): void {
    const entry: MatchDecisionEntry = {
      id: `md-${userId}-${candidateId}-${Date.now()}`,
      layer: 'match_decision',
      userId,
      writerAgent: 'match',
      timestamp: Date.now(),
      payload: {
        candidateId,
        overallScore,
        dimensionScores,
        tagTrace,
        recommendedAt: Date.now(),
      },
    }
    globalMemoryBus.writeMatchDecision('match', entry)
  },

  /**
   * recordFeedback() — 用户反馈
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → matchAdapter.recordFeedback()
   */
  recordFeedback(
    userId: string,
    candidateId: string,
    feedback: 1 | 0 | -1,
  ): boolean {
    return globalMemoryBus.updateMatchFeedback('match', userId, candidateId, feedback)
  },

  /**
   * getVectorCandidates() — 向量召回候选
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → matchAdapter.getVectorCandidates()
   */
  getVectorCandidates(
    queryVector: number[],
    limit: number = 10,
    excludeUserIds: string[] = [],
  ) {
    return globalMemoryBus.searchByVector('match', queryVector, limit, excludeUserIds)
  },
}

// ════════════════════════════════════════════════════════════
//  IceBreakerAgent 适配器
// ════════════════════════════════════════════════════════════

/**
 * iceBreakerAdapter — IceBreakerAgent 用 MemoryBus 的桥接
 * 文件路径：server/src/integrations/agentMemoryAdapter.ts → iceBreakerAdapter
 */
export const iceBreakerAdapter = {
  /**
   * getPeerProfile() — 拿对方画像（找共同点用）
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → iceBreakerAdapter.getPeerProfile()
   */
  getPeerProfile(peerId: string) {
    return globalMemoryBus.readLongTermProfile('icebreaker', peerId)
  },

  /**
   * getUsedTopics() — 拿用过的话题（避免重复）
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → iceBreakerAdapter.getUsedTopics()
   */
  getUsedTopics(userId: string): string[] {
    return globalMemoryBus.getUsedTopics('icebreaker', userId)
  },

  /**
   * getEffectStats() — 拿话术效果统计（优化策略用）
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → iceBreakerAdapter.getEffectStats()
   */
  getEffectStats(userId: string): Record<string, number> {
    return globalMemoryBus.getIceBreakerEffectStats('icebreaker', userId)
  },

  /**
   * recordInteraction() — 记录一次破冰
   * 文件路径：server/src/integrations/agentMemoryAdapter.ts → iceBreakerAdapter.recordInteraction()
   */
  recordInteraction(
    userId: string,
    peerId: string,
    iceBreakerType: string,
    iceBreakerText: string,
    topicsUsed: string[],
    effect: 1 | 0 | -1,
  ): void {
    const entry: InteractionEntry = {
      id: `it-${userId}-${peerId}-${Date.now()}`,
      layer: 'interaction',
      userId,
      writerAgent: 'icebreaker',
      timestamp: Date.now(),
      payload: {
        peerId,
        iceBreakerType,
        iceBreakerText,
        topicsUsed,
        effect,
        interactedAt: Date.now(),
      },
    }
    globalMemoryBus.writeInteraction('icebreaker', entry)
  },
}
