// ============================================================
// longTermProfileMemory.ts — Layer 2 长期画像记忆（核心）
// 文件路径：server/src/memory/longTermProfileMemory.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  Layer 2：全 Agent 共享的长期画像，匹配计算的核心依据。      ║
// ║                                                            ║
// ║  ▼▼▼ 双存储 = 结构化标签 + 语义向量 ▼▼▼                    ║
// ║                                                            ║
// ║  ① 结构化标签（ProfileTag[]）                              ║
// ║     - 类别：属性/兴趣/社交/雷区/mbti                       ║
// ║     - 每个标签带：name + value + confidence + evidence     ║
// ║     - 例：{category:'interest', name:'跑步', value:'喜欢', ║
// ║            confidence:0.85, evidence:['每周3次晨跑']}      ║
// ║     - 优点：可解释、可精确匹配、可增量更新                  ║
// ║                                                            ║
// ║  ② 语义向量（number[]）                                    ║
// ║     - 把所有标签拼成文本，调 embedding 服务算向量          ║
// ║     - 例：[0.12, -0.34, 0.56, ...]（768 维或更高）         ║
// ║     - 优点：相似度计算快、捕获语义、跨用户匹配             ║
// ║                                                            ║
// ║  ▼▼▼ 为什么双存储？ ▼▼▼                                     ║
// ║    - 标签：精确匹配（"跑步" == "跑步"）但死板              ║
// ║    - 向量：模糊匹配（"跑步" ≈ "慢跑" ≈ "马拉松"）但不可解释║
// ║    - 双存储 = 精确+模糊 = 可解释+智能                      ║
// ║                                                            ║
// ║  ▼▼▼ 情景：小王画像增量演化 ▼▼▼                            ║
// ║                                                            ║
// ║    第 1 次聊天后：                                         ║
// ║      tags = [{interest, 跑步, 喜欢, 0.7, ['喜欢跑步']}]   ║
// ║      vector = embed("喜欢跑步")                            ║
// ║                                                            ║
// ║    第 5 次聊天后（增量更新）：                              ║
// ║      tags = [                                              ║
// ║        {interest, 跑步, 喜欢, 0.85, ['喜欢跑步','每周3次']},║
// ║        {interest, 夜跑, prefer, 0.7, ['prefer夜跑']}      ║
// ║        {attribute, 城市, 北京, 0.9, ['北京']}             ║
// ║        {mbti, INFJ, type, 0.62, [...]}                    ║
// ║      ]                                                     ║
// ║      vector = embed("喜欢跑步每周3次 prefer夜跑 北京 INFJ")║
// ║                                                            ║
// ║    MatchAgent 匹配时：                                     ║
// ║      ① 算向量相似度（小王 vector vs 候选 vector）          ║
// ║      ② 算标签精确匹配（小王 tags ∩ 候选 tags）             ║
// ║      ③ 综合得分 = 0.6×向量 + 0.4×标签                     ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - memory/memoryBus.ts
//   - integrations/agentMemoryAdapter.ts（ProfileAgent 增量写入）
//
//   它调用：
//   - ./memoryTypes.js → LongTermProfileEntry, ProfileTag, MEMORY_CONFIG
//   - ../mbti/index.js → MbtiProfile 类型
//   - ../services/embedding.js → 向量计算（可选）
// ============================================================

import type { MbtiProfile } from '../mbti/mbtiTypes.js'
import {
  type LongTermProfileEntry,
  type ProfileTag,
  MEMORY_CONFIG,
} from './memoryTypes.js'

/**
 * LongTermProfileMemory — Layer 2 长期画像记忆实现
 * 文件路径：server/src/memory/longTermProfileMemory.ts → class LongTermProfileMemory
 *
 * 用 Map<userId, LongTermProfileEntry> 存储
 * 每个用户对应一条画像 entry
 *
 * 持久化：内存+Redis 双写（redis/ 模块负责 Redis 同步）
 */
export class LongTermProfileMemory {
  private readonly _store = new Map<string, LongTermProfileEntry>()

  /**
   * read() — 读用户画像
   * 文件路径：server/src/memory/longTermProfileMemory.ts → LongTermProfileMemory.read()
   */
  read(userId: string): LongTermProfileEntry | null {
    return this._store.get(userId) ?? null
  }

  /**
   * update() — 增量更新画像（核心 API）
   * 文件路径：server/src/memory/longTermProfileMemory.ts → LongTermProfileMemory.update()
   *
   * @param userId       - 用户 ID
   * @param newTags      - 新抽取的标签（要并入的）
   * @param newMbti      - 新的 MBTI 画像（可选）
   * @param vector       - 新算的语义向量（可选，不传就不更新）
   * @returns 更新后的 entry
   *
   * 增量合并规则：
   *   - 同名同类标签：confidence 取 max，evidence 累加去重
   *   - 新标签：直接加入
   *   - 置信度 < longTermConfidenceThreshold 的新标签丢弃（噪音过滤）
   *   - MBTI：直接覆盖（mbti/ 模块的 applyDimensionPatch 已做增量）
   *   - vector：直接覆盖（每次全量重算）
   *   - version+1
   */
  update(
    userId: string,
    newTags: ProfileTag[],
    newMbti?: MbtiProfile,
    vector?: number[],
  ): LongTermProfileEntry {
    const existing = this._store.get(userId)

    // 过滤掉低置信度的新标签（噪音）
    const validNewTags = newTags.filter(
      t => t.confidence >= MEMORY_CONFIG.longTermConfidenceThreshold
    )

    if (!existing) {
      // 新用户：直接创建
      const entry: LongTermProfileEntry = {
        id: `ltp-${userId}-${Date.now()}`,
        layer: 'long_term_profile',
        userId,
        writerAgent: 'profile',
        timestamp: Date.now(),
        payload: {
          tags: validNewTags,
          vector,
          mbti: newMbti,
          overallConfidence: computeOverallConfidence(validNewTags),
          version: 1,
        },
      }
      this._store.set(userId, entry)
      return entry
    }

    // 老用户：增量合并标签
    const mergedTags = mergeTags(existing.payload.tags, validNewTags)

    // 更新 entry
    existing.payload.tags = mergedTags
    if (newMbti) existing.payload.mbti = newMbti
    if (vector) existing.payload.vector = vector
    existing.payload.overallConfidence = computeOverallConfidence(mergedTags)
    existing.payload.version += 1
    existing.timestamp = Date.now()

    return existing
  }

  /**
   * searchByVector() — 向量相似度搜索（找最相似的用户）
   * 文件路径：server/src/memory/longTermProfileMemory.ts → LongTermProfileMemory.searchByVector()
   *
   * @param queryVector - 查询向量
   * @param limit       - 返回前 N 个
   * @param excludeUserIds - 排除的用户 ID 列表（如已推荐过的）
   * @returns 按相似度降序排列的 [userId, similarity] 数组
   *
   * 场景：MatchAgent 拿小王的向量，找最相似的候选
   */
  searchByVector(
    queryVector: number[],
    limit: number = 10,
    excludeUserIds: string[] = [],
  ): { userId: string; similarity: number }[] {
    const results: { userId: string; similarity: number }[] = []

    for (const [userId, entry] of this._store) {
      if (excludeUserIds.includes(userId)) continue
      if (!entry.payload.vector) continue

      const sim = cosineSimilarity(queryVector, entry.payload.vector)
      results.push({ userId, similarity: sim })
    }

    // 按相似度降序排序，取前 N
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  }

  /**
   * getTagsByCategory() — 按类别取标签（MatchAgent 用）
   * 文件路径：server/src/memory/longTermProfileMemory.ts → LongTermProfileMemory.getTagsByCategory()
   *
   * 场景：MatchAgent 只要"兴趣"类标签做精确匹配
   */
  getTagsByCategory(userId: string, category: ProfileTag['category']): ProfileTag[] {
    const entry = this._store.get(userId)
    if (!entry) return []
    return entry.payload.tags.filter(t => t.category === category)
  }

  /**
   * serialize() / restore() — 序列化/反序列化（存 Redis 用）
   */
  serialize(): string {
    return JSON.stringify(Array.from(this._store.entries()))
  }

  restore(serialized: string): void {
    try {
      const arr = JSON.parse(serialized) as [string, LongTermProfileEntry][]
      this._store.clear()
      for (const [k, v] of arr) this._store.set(k, v)
    } catch {
      // 恢复失败忽略
    }
  }
}

// ════════════════════════════════════════════════════════════
//  【内部工具函数】
// ════════════════════════════════════════════════════════════

/**
 * mergeTags() — 合并新老标签（增量更新核心算法）
 * 文件路径：server/src/memory/longTermProfileMemory.ts → mergeTags()
 *
 * 规则：
 *   - 同 category + 同 name：confidence 取 max，evidence 累加去重，value 取新的
 *   - 新标签：直接加入
 */
function mergeTags(old: ProfileTag[], fresh: ProfileTag[]): ProfileTag[] {
  const result: ProfileTag[] = old.map(t => ({ ...t, evidence: [...t.evidence] }))

  for (const nt of fresh) {
    const idx = result.findIndex(
      t => t.category === nt.category && t.name === nt.name
    )
    if (idx >= 0) {
      // 同标签：合并
      const existing = result[idx]
      existing.confidence = Math.max(existing.confidence, nt.confidence)
      if (nt.value) existing.value = nt.value
      for (const ev of nt.evidence) {
        if (!existing.evidence.includes(ev)) existing.evidence.push(ev)
      }
      existing.updatedAt = Date.now()
    } else {
      // 新标签：加入
      result.push({ ...nt, evidence: [...nt.evidence] })
    }
  }

  return result
}

/**
 * computeOverallConfidence() — 算整体置信度（所有标签 confidence 的平均）
 * 文件路径：server/src/memory/longTermProfileMemory.ts → computeOverallConfidence()
 */
function computeOverallConfidence(tags: ProfileTag[]): number {
  if (tags.length === 0) return 0
  return Math.round(
    tags.reduce((s, t) => s + t.confidence, 0) / tags.length * 100
  ) / 100
}

/**
 * cosineSimilarity() — 余弦相似度（向量匹配核心算法）
 * 文件路径：server/src/memory/longTermProfileMemory.ts → cosineSimilarity()
 *
 * 公式：cos(A, B) = (A·B) / (|A| × |B|)
 *
 * 场景：小王向量 [0.1, 0.2, ...] vs 候选向量 [0.15, 0.18, ...]
 *      → 相似度 0.95（很相似）
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dot = 0    // 点积 A·B
  let normA = 0  // |A|²
  let normB = 0  // |B|²
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return Math.round(dot / denom * 1000) / 1000   // 保留 3 位小数
}
