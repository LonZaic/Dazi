// ============================================================
// memoryBus.ts — 统一记忆总线（核心架构）
// 文件路径：server/src/memory/memoryBus.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这是整个记忆系统的"中枢神经"——                            ║
// ║  所有 Agent 通过 MemoryBus 读写记忆，bus 内部路由到 4 层。   ║
// ║                                                            ║
// ║  ▼▼▼ 为啥要总线？ ▼▼▼                                       ║
// ║    - 4 层记忆各自有 API，调用方要记 4 套                    ║
// ║    - 总线统一接口：read(layer, query) / write(layer, entry)║
// ║    - 总线内部按 layer 路由到对应层                          ║
// ║    - 总线做权限控制（ProfileAgent 不能写 Layer 3/4）       ║
// ║    - 总线做跨进程同步（写后通知 Redis）                    ║
// ║                                                            ║
// ║  ▼▼▼ 情景：3 Agent 通过总线协作 ▼▼▼                         ║
// ║                                                            ║
// ║    ProfileAgent：                                          ║
// ║      bus.write('short_term', {sessionId, messages:[...]})  ║
// ║      bus.write('long_term_profile', {tags:[...]})          ║
// ║      bus.read('long_term_profile', {userId}) → 拿老画像    ║
// ║                                                            ║
// ║    MatchAgent：                                            ║
// ║      bus.read('long_term_profile', {userId}) → 拿画像      ║
// ║      bus.search('long_term_profile', {vector, limit:10})   ║
// ║        → 拿相似候选                                        ║
// ║      bus.read('match_decision', {userId})                  ║
// ║        → 拿历史推荐（去重）                                ║
// ║      bus.write('match_decision', {candidateId, score})     ║
// ║                                                            ║
// ║    IceBreakerAgent：                                       ║
// ║      bus.read('long_term_profile', {userId}) → 拿双方画像  ║
// ║      bus.read('interaction', {userId})                     ║
// ║        → 拿历史话术（避免重复）                            ║
// ║      bus.write('interaction', {peerId, iceBreakerText})    ║
// ║                                                            ║
// ║    三 Agent 各自读写，互不干扰，通过总线"无感协作"          ║
// ║                                                            ║
// ║  ▼▼▼ 权限控制怎么做？ ▼▼▼                                   ║
// ║    MEMORY_PERMISSIONS 定义了 3×4 权限矩阵                  ║
// ║    每次 read/write 前校验 agent 是否有权限                 ║
// ║    无权限抛错（防止 Agent 越权）                           ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   所有 Agent → MemoryBus → 4 层记忆 → (Redis 持久化)
//
//   ┌──────────────┐
//   │ ProfileAgent │──┐
//   └──────────────┘  │
//   ┌──────────────┐  │    ┌──────────┐    ┌─────────────────┐
//   │  MatchAgent  │──┼───→│MemoryBus │───→│ 4 层记忆实现     │
//   └──────────────┘  │    └──────────┘    └─────────────────┘
//   ┌──────────────┐  │
//   │IceBreakerAg. │──┘
//   └──────────────┘
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - integrations/agentMemoryAdapter.ts（包装 3 个 Agent）
//   - integrations/lifecycleAdapter.ts（重启恢复）
//
//   它调用：
//   - ./memoryTypes.js → 类型 + MEMORY_PERMISSIONS
//   - ./shortTermMemory.js → Layer 1
//   - ./longTermProfileMemory.js → Layer 2
//   - ./matchDecisionMemory.js → Layer 3
//   - ./interactionMemory.js → Layer 4
// ============================================================

import {
  type MemoryLayer,
  type AgentId,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryPermission,
  type ShortTermEntry,
  type LongTermProfileEntry,
  type MatchDecisionEntry,
  type InteractionEntry,
  type ProfileTag,
  MEMORY_PERMISSIONS,
} from './memoryTypes.js'
import { ShortTermMemory } from './shortTermMemory.js'
import { LongTermProfileMemory } from './longTermProfileMemory.js'
import { MatchDecisionMemory } from './matchDecisionMemory.js'
import { InteractionMemory } from './interactionMemory.js'
import type { MbtiProfile } from '../mbti/mbtiTypes.js'

/**
 * MemoryBus — 统一记忆总线（核心类）
 * 文件路径：server/src/memory/memoryBus.ts → class MemoryBus
 *
 * 单例模式（一个进程一个 bus）
 * 持有 4 层记忆的实例，对外提供统一 read/write/search 接口
 */
export class MemoryBus {
  /** Layer 1 短期会话记忆 */
  readonly shortTerm: ShortTermMemory
  /** Layer 2 长期画像记忆 */
  readonly longTermProfile: LongTermProfileMemory
  /** Layer 3 匹配决策记忆 */
  readonly matchDecision: MatchDecisionMemory
  /** Layer 4 撮合交互记忆 */
  readonly interaction: InteractionMemory

  constructor() {
    this.shortTerm = new ShortTermMemory()
    this.longTermProfile = new LongTermProfileMemory()
    this.matchDecision = new MatchDecisionMemory()
    this.interaction = new InteractionMemory()
  }

  /**
   * checkPermission() — 权限校验
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.checkPermission()
   *
   * @param agent   - 哪个 Agent
   * @param layer   - 要访问哪层
   * @param action  - 'read' 还是 'write'
   * @returns true=允许，false=拒绝
   */
  private checkPermission(
    agent: AgentId,
    layer: MemoryLayer,
    action: 'read' | 'write',
  ): boolean {
    const perm: MemoryPermission = MEMORY_PERMISSIONS[agent][layer]
    if (perm === 'readwrite') return true
    if (perm === 'read' && action === 'read') return true
    if (perm === 'write' && action === 'write') return true
    return false
  }

  /**
   * read() — 通用读接口（按 layer 路由）
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.read()
   *
   * @param agent  - 哪个 Agent 在读
   * @param layer  - 读哪层
   * @param query  - 查询条件
   * @returns 该层的查询结果（具体类型由 layer 决定）
   *
   * 权限不足抛错
   */
  read(
    agent: AgentId,
    layer: MemoryLayer,
    query: MemoryQuery,
  ): MemoryEntry[] | MemoryEntry | null {
    if (!this.checkPermission(agent, layer, 'read')) {
      throw new Error(`权限拒绝：${agent} 无权读 ${layer}`)
    }

    switch (layer) {
      case 'short_term': {
        // Layer 1 按 sessionId 读（query.userId 当 sessionId 用）
        return this.shortTerm.read(query.userId)
      }
      case 'long_term_profile': {
        return this.longTermProfile.read(query.userId)
      }
      case 'match_decision': {
        return this.matchDecision.read(query.userId)
      }
      case 'interaction': {
        return this.interaction.read(query.userId)
      }
      default:
        return null
    }
  }

  /**
   * write() — 通用写接口（按 layer 路由）
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.write()
   *
   * @param agent  - 哪个 Agent 在写
   * @param entry  - 要写的条目（layer 字段决定写哪层）
   *
   * 权限不足抛错
   */
  write(agent: AgentId, entry: MemoryEntry): void {
    if (!this.checkPermission(agent, entry.layer, 'write')) {
      throw new Error(`权限拒绝：${agent} 无权写 ${entry.layer}`)
    }

    switch (entry.layer) {
      case 'short_term':
        // Layer 1 用专用 append 接口（不走通用 write）
        throw new Error('Layer 1 请用 appendShortTerm()')
      case 'long_term_profile':
        // Layer 2 用专用 update 接口
        throw new Error('Layer 2 请用 updateLongTermProfile()')
      case 'match_decision':
        this.matchDecision.write(entry.userId, entry as MatchDecisionEntry)
        break
      case 'interaction':
        this.interaction.write(entry.userId, entry as InteractionEntry)
        break
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Layer 1 短期会话记忆 专用接口
  // ════════════════════════════════════════════════════════════

  /**
   * appendShortTerm() — Layer 1 追加消息
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.appendShortTerm()
   *
   * 场景：ProfileAgent 每轮对话调这个
   */
  appendShortTerm(
    agent: AgentId,
    userId: string,
    sessionId: string,
    message: { role: string; content: string },
  ): void {
    if (!this.checkPermission(agent, 'short_term', 'write')) {
      throw new Error(`权限拒绝：${agent} 无权写 short_term`)
    }
    // ChatMessage 类型兼容（role 是 string，运行时无所谓）
    this.shortTerm.append(userId, sessionId, message as any)
  }

  /**
   * settleSession() — Layer 1 会话结束，沉淀到 Layer 2
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.settleSession()
   *
   * @param userId    - 用户 ID
   * @param sessionId - 会话 ID
   * @returns 该会话的 entry（含 messages + tempPatch），调用方拿去喂 Layer 2
   */
  settleSession(userId: string, sessionId: string): ShortTermEntry | null {
    return this.shortTerm.settleAndClear(sessionId)
  }

  // ════════════════════════════════════════════════════════════
  //  Layer 2 长期画像记忆 专用接口
  // ════════════════════════════════════════════════════════════

  /**
   * updateLongTermProfile() — Layer 2 增量更新画像
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.updateLongTermProfile()
   *
   * 场景：ProfileAgent 抽完画像 patch 调这个
   */
  updateLongTermProfile(
    agent: AgentId,
    userId: string,
    newTags: ProfileTag[],
    newMbti?: MbtiProfile,
    vector?: number[],
  ): LongTermProfileEntry {
    if (!this.checkPermission(agent, 'long_term_profile', 'write')) {
      throw new Error(`权限拒绝：${agent} 无权写 long_term_profile`)
    }
    return this.longTermProfile.update(userId, newTags, newMbti, vector)
  }

  /**
   * readLongTermProfile() — Layer 2 读画像
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.readLongTermProfile()
   */
  readLongTermProfile(agent: AgentId, userId: string): LongTermProfileEntry | null {
    if (!this.checkPermission(agent, 'long_term_profile', 'read')) {
      throw new Error(`权限拒绝：${agent} 无权读 long_term_profile`)
    }
    return this.longTermProfile.read(userId)
  }

  /**
   * searchByVector() — Layer 2 向量搜索（MatchAgent 用）
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.searchByVector()
   */
  searchByVector(
    agent: AgentId,
    queryVector: number[],
    limit: number = 10,
    excludeUserIds: string[] = [],
  ): { userId: string; similarity: number }[] {
    if (!this.checkPermission(agent, 'long_term_profile', 'read')) {
      throw new Error(`权限拒绝：${agent} 无权读 long_term_profile`)
    }
    return this.longTermProfile.searchByVector(queryVector, limit, excludeUserIds)
  }

  // ════════════════════════════════════════════════════════════
  //  Layer 3 匹配决策记忆 专用接口
  // ════════════════════════════════════════════════════════════

  /**
   * writeMatchDecision() — Layer 3 写匹配决策
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.writeMatchDecision()
   */
  writeMatchDecision(agent: AgentId, entry: MatchDecisionEntry): void {
    if (!this.checkPermission(agent, 'match_decision', 'write')) {
      throw new Error(`权限拒绝：${agent} 无权写 match_decision`)
    }
    this.matchDecision.write(entry.userId, entry)
  }

  /**
   * getRecentCandidates() — Layer 3 拿最近推荐（去重用）
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.getRecentCandidates()
   */
  getRecentCandidates(agent: AgentId, userId: string, window?: number): string[] {
    if (!this.checkPermission(agent, 'match_decision', 'read')) {
      throw new Error(`权限拒绝：${agent} 无权读 match_decision`)
    }
    return this.matchDecision.getRecentCandidates(userId, window)
  }

  /**
   * updateMatchFeedback() — Layer 3 更新反馈
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.updateMatchFeedback()
   */
  updateMatchFeedback(
    agent: AgentId,
    userId: string,
    candidateId: string,
    feedback: 1 | 0 | -1,
  ): boolean {
    if (!this.checkPermission(agent, 'match_decision', 'write')) {
      throw new Error(`权限拒绝：${agent} 无权写 match_decision`)
    }
    return this.matchDecision.updateFeedback(userId, candidateId, feedback)
  }

  // ════════════════════════════════════════════════════════════
  //  Layer 4 撮合交互记忆 专用接口
  // ════════════════════════════════════════════════════════════

  /**
   * writeInteraction() — Layer 4 写破冰交互
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.writeInteraction()
   */
  writeInteraction(agent: AgentId, entry: InteractionEntry): void {
    if (!this.checkPermission(agent, 'interaction', 'write')) {
      throw new Error(`权限拒绝：${agent} 无权写 interaction`)
    }
    this.interaction.write(entry.userId, entry)
  }

  /**
   * getUsedTopics() — Layer 4 拿用过的话题（去重用）
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.getUsedTopics()
   */
  getUsedTopics(agent: AgentId, userId: string, window?: number): string[] {
    if (!this.checkPermission(agent, 'interaction', 'read')) {
      throw new Error(`权限拒绝：${agent} 无权读 interaction`)
    }
    return this.interaction.getUsedTopics(userId, window)
  }

  /**
   * getIceBreakerEffectStats() — Layer 4 话术效果统计
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.getIceBreakerEffectStats()
   */
  getIceBreakerEffectStats(agent: AgentId, userId: string): Record<string, number> {
    if (!this.checkPermission(agent, 'interaction', 'read')) {
      throw new Error(`权限拒绝：${agent} 无权读 interaction`)
    }
    return this.interaction.getIceBreakerEffectStats(userId)
  }

  // ════════════════════════════════════════════════════════════
  //  序列化/反序列化（Redis 持久化用）
  // ════════════════════════════════════════════════════════════

  /**
   * serializeAll() — 序列化全部 4 层（存 Redis 用）
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.serializeAll()
   *
   * 场景：进程重启前调这个，把全部记忆持久化
   */
  serializeAll(): {
    shortTerm: string
    longTermProfile: string
    matchDecision: string
    interaction: string
  } {
    return {
      shortTerm: this.shortTerm.serialize(),
      longTermProfile: this.longTermProfile.serialize(),
      matchDecision: this.matchDecision.serialize(),
      interaction: this.interaction.serialize(),
    }
  }

  /**
   * restoreAll() — 从序列化数据恢复全部 4 层
   * 文件路径：server/src/memory/memoryBus.ts → MemoryBus.restoreAll()
   *
   * 场景：进程重启后调这个，从 Redis 恢复
   */
  restoreAll(data: {
    shortTerm?: string
    longTermProfile?: string
    matchDecision?: string
    interaction?: string
  }): void {
    if (data.shortTerm) this.shortTerm.restore(data.shortTerm)
    if (data.longTermProfile) this.longTermProfile.restore(data.longTermProfile)
    if (data.matchDecision) this.matchDecision.restore(data.matchDecision)
    if (data.interaction) this.interaction.restore(data.interaction)
  }
}

/**
 * 全局单例（一个进程一个 MemoryBus）
 * 文件路径：server/src/memory/memoryBus.ts → globalMemoryBus
 *
 * 用法：import { globalMemoryBus } from '../memory/index.js'
 *      globalMemoryBus.readLongTermProfile('match', userId)
 */
export const globalMemoryBus = new MemoryBus()
