// ============================================================
// vectorStore.ts — 向量存储与召回（SQLite + 纯 JS 余弦相似度）
// 文件路径：server/src/db/vectorStore.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是"匹配引擎的召回层"——存向量 + 算相似度 + 排序。   ║
// ║                                                            ║
// ║  存：upsertVector() → 把画像向量写进 profiles.embedding      ║
// ║  查：recallByVector() → 我的向量 vs 全员向量，取最像 topK    ║
// ║                                                            ║
// ║  当前实现：SQLite 存向量(JSON) + 纯 JS 余弦                  ║
// ║  - 开箱即跑，零外部依赖                                      ║
// ║  - 接口已抽象：百万级可平滑迁移 pgvector（仅替换本文件）      ║
// ║                                                            ║
// ║  召回延迟：<100ms（千级用户），满足 <2s 要求                  ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王点"匹配"，vectorStore 召回过程 ▼▼▼
//
//   小王点"开始匹配"
//        │
//        ▼
//   MatchAgent.run() → recallByVector(myVec, 'default', '小王ID', 50)
//        │
//        ▼
//   ① 查库：SELECT user_id, embedding, profile_json FROM profiles
//            WHERE tenant_id='default' AND user_id != '小王ID'
//              AND embedding IS NOT NULL
//        │
//        ▼
//   ② 遍历每个候选：
//      - JSON.parse(embedding) → 候选向量
//      - JSON.parse(profile_json) → 候选画像快照
//      - cosine(myVec, 候选向量) → 相似度分数
//        例：小王 vs 小李 0.87（很像）
//            小王 vs 小张 0.45（一般）
//        │
//        ▼
//   ③ 按分数降序排：[{小李, 0.87}, {小赵, 0.79}, {小张, 0.45}, ...]
//        │
//        ▼
//   ④ slice(0, 50) → 取前 50 个返回
//        │
//        ▼
//   MatchAgent 拿到 50 个候选 → 用 LLM 重排序 → 返回 top 5
//
// ════════════════════════════════════════════════════════════
//  【余弦相似度是什么？】
// ════════════════════════════════════════════════════════════
//   把画像当成 256 维空间里的一个箭头（向量）。
//   两个箭头夹角越小 → 越像。
//   cos(0°) = 1（完全一样），cos(90°) = 0（无关），cos(180°) = -1（相反）
//
//   公式：cos(A, B) = (A·B) / (|A| × |B|)
//   A·B = 各分量乘积之和（点积）
//   |A| = √(各分量平方和)（向量长度）
//
//   注意：向量要先归一化（长度=1），这样点积=余弦。
//   本系统在 embedding.ts 里已做 L2 归一化。
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   写入：ProfileAgent → upsertVector() → 存向量
//   读取：MatchAgent → recallByVector() → 召回候选
//   种子：scripts/seed.ts → upsertVector() → 种子用户预置向量
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - agents/matchAgent.ts: recallByVector（召回候选）
//   - agents/profileAgent.ts: upsertVector（画像更新后存向量）
//   - scripts/seed.ts: upsertVector（种子数据预置向量）
//
//   它调用：
//   - db/index.js → getDB（查库）
//   - JSON.parse（向量从 JSON 字符串还原成数组）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - interface → 定义数据结构
//   - Math.sqrt → 开平方（算向量长度）
//   - scored.sort((a, b) => b.score - a.score) → 按分数降序排
//   - slice(0, topK) → 取前 N 个
// ============================================================

import { getDB } from './index.js'  // 数据库连接

// 【interface】向量记录（一条 = 一个用户的向量+画像快照）
// 文件路径：server/src/db/vectorStore.ts
export interface VectorRecord {
  userId: string      // 用户 ID
  tenantId: string    // 租户 ID
  vector: number[]    // 向量（256 维数组）
  profile: ProfileSnapshot  // 画像快照（召回后排序用，避免再查库）
}

/** 画像快照（召回后用于排序，避免再查库） */
// 文件路径：server/src/db/vectorStore.ts
export interface ProfileSnapshot {
  displayName: string                              // 显示名
  confidence: number                               // 画像置信度
  interests: string[]                              // 兴趣列表
  socialStyle: { depth: string; energy: string }   // 社交风格
  schedule: string[]                               // 活跃时段
  goal: string                                     // 找搭子目标
}

/**
 * 余弦相似度 — 纯 JS 实现（等价于 pgvector 的 <=> 操作符）
 * 文件路径：server/src/db/vectorStore.ts → cosine()
 *
 * 公式：cos(A, B) = (A·B) / (|A| × |B|)
 *   A·B = 各分量乘积之和（点积）
 *   |A| = √(各分量平方和)（向量长度）
 *
 * 返回值：-1 到 1，越接近 1 越相似
 */
export function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)  // 取较短的（防长度不一致）
  let dot = 0, na = 0, nb = 0               // dot=点积, na=|A|², nb=|B|²
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!   // 点积累加
    na += a[i]! * a[i]!    // |A|² 累加
    nb += b[i]! * b[i]!    // |B|² 累加
  }
  if (na === 0 || nb === 0) return 0  // 零向量 → 不相似（防除以 0）
  return dot / (Math.sqrt(na) * Math.sqrt(nb))  // 点积 / (|A| × |B|)
}

/**
 * 写入/更新用户向量（upsert）
 *   upsert = update + insert（存在就更新，不存在就插入）
 * 文件路径：server/src/db/vectorStore.ts → upsertVector()
 */
export function upsertVector(
  userId: string,
  tenantId: string,
  vector: number[],
  profile: ProfileSnapshot,
): void {
  const db = getDB()
  // 向量存成 JSON 字符串（SQLite 没有原生向量类型）
  db.prepare(`
    UPDATE profiles
    SET embedding = ?, updated_at = unixepoch()
    WHERE user_id = ?
  `).run(JSON.stringify(vector), userId)
  // profile_json 在 profileAgent 写入时已更新，这里只同步向量
  void profile  // void：显式标记"这个参数暂时没用"（避免 TS 警告未使用参数）
}

/**
 * 召回：对同租户内所有有向量的用户做余弦排序，返回 topK
 * 文件路径：server/src/db/vectorStore.ts → recallByVector()
 *
 * 多租户隔离：WHERE tenant_id 必带（保证 A 公司的用户看不到 B 公司的用户）
 *
 * @param queryVec      - 查询向量（我的画像向量）
 * @param tenantId      - 租户 ID（隔离用）
 * @param excludeUserId - 排除自己（不匹配自己）
 * @param topK          - 返回前 K 个
 * @returns 按相似度降序排列的候选列表
 */
export function recallByVector(
  queryVec: number[],
  tenantId: string,
  excludeUserId: string,
  topK: number,
): Array<{ userId: string; score: number; profile: ProfileSnapshot }> {
  const db = getDB()
  // 查同租户、排除自己、有向量、有画像的所有用户
  const rows = db.prepare(`
    SELECT user_id, embedding, profile_json, confidence, display_name
    FROM profiles p
    JOIN users u ON u.id = p.user_id       -- 关联用户表拿显示名
    WHERE p.tenant_id = ?                   -- 租户隔离
      AND p.user_id != ?                    -- 排除自己
      AND p.embedding IS NOT NULL           -- 必须有向量
      AND p.confidence >= ?                 -- 置信度 ≥ 0（有画像即可）
  `).all(tenantId, excludeUserId, 0) as Array<{
    user_id: string
    embedding: string
    profile_json: string
    confidence: number
    display_name: string | null
  }>

  // 对每个候选：解析向量 + 解析画像 → 算余弦相似度
  const scored = rows.map(r => {
    let vec: number[] = []
    let prof: ProfileSnapshot
    try {
      vec = JSON.parse(r.embedding)              // 向量 JSON → 数组
      const pj = JSON.parse(r.profile_json)      // 画像 JSON → 对象
      prof = {
        displayName: r.display_name || '匿名用户',
        confidence: r.confidence,
        interests: pj.interests?.map((i: any) => i.name) || [],
        socialStyle: {
          depth: pj.socialStyle?.depth || 'unknown',
          energy: pj.socialStyle?.energy || 'unknown',
        },
        schedule: pj.schedule || [],
        goal: pj.goal || '',
      }
    } catch {
      // JSON 解析失败 → 给个空画像（容错，不崩）
      prof = {
        displayName: r.display_name || '匿名用户',
        confidence: r.confidence,
        interests: [],
        socialStyle: { depth: 'unknown', energy: 'unknown' },
        schedule: [],
        goal: '',
      }
    }
    // 算余弦相似度：我的向量 vs 候选向量
    return { userId: r.user_id, score: cosine(queryVec, vec), profile: prof }
  })

  // 按相似度降序排（最像的在前）
  scored.sort((a, b) => b.score - a.score)
  // 取前 topK 个
  return scored.slice(0, topK)
}
