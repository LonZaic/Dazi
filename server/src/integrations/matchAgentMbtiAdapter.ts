// ============================================================
// matchAgentMbtiAdapter.ts — MBTI 兼容度 ↔ MatchAgent 桥接适配器
// 文件路径：server/src/integrations/matchAgentMbtiAdapter.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  把 mbti/mbtiCompat.ts 的"两人 MBTI 兼容度"挂到           ║
// ║  MatchAgent 上，作为第 6 维因子，零侵入。                   ║
// ║                                                            ║
// ║  ▼▼▼ 为什么需要适配器？ ▼▼▼                                 ║
// ║    MatchAgent 已有 5 维因子（vector/interest/style/        ║
// ║    schedule/goal），用"两方画像 + 向量分"算出来的。          ║
// ║    MBTI 兼容度需要的是"两方 MBTI 画像"，输入形状不一样。    ║
// ║    适配器负责：                                            ║
// ║      ① 从 mbtiProfileAdapter 拿双方 MBTI 画像              ║
// ║      ② 调 scoreCompat() 算兼容度                           ║
// ║      ③ 打包成 MatchAgent 能直接用的 {score, reason, ...}   ║
// ║      ④ 不改 matchAgent.ts 的核心算法骨架                   ║
// ║                                                            ║
// ║  ▼▼▼ 情景：小王 INFJ vs 候选小李 ENFP ▼▼▼                  ║
// ║                                                            ║
// ║    适配器被 MatchAgent 调用：                              ║
// ║      computeMbtiFactor('小王', '小李')                     ║
// ║        │                                                   ║
// ║        ▼                                                   ║
// ║    ① getMbtiProfile('小王') → { type:'INFJ', conf:0.85 }  ║
// ║    ② getMbtiProfile('小李') → { type:'ENFP', conf:0.78 }  ║
// ║    ③ scoreCompat(mine, theirs) →                          ║
// ║         { score:0.82, reason:'功能栈黄金互补...',          ║
// ║           detail:{ functionComplement:0.85, ... } }       ║
// ║    ④ 返回：                                                ║
// ║         { score:0.82, reason:'...', mineType:'INFJ',       ║
// ║           theirsType:'ENFP', detail:{...} }               ║
// ║                                                            ║
// ║    MatchAgent 把 score 当第 6 维因子加权进综合分           ║
// ║    前端 MatchCard 把 theirsType 显示成搭子卡上的徽章       ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   MatchAgent.execute()
//        │
//        ▼ （新增 hook，零侵入）
//   computeMbtiFactor(myUserId, candidateUserId)
//        │
//        ▼
//   ① getMbtiProfile() 从 MemoryBus Layer 2 拿双方 MBTI 画像
//   ② scoreCompat() 算兼容度（3 子分加权）
//        │
//        ▼
//   返回 MbtiCompatFactor，挂在 MatchCandidate 上
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - agents/matchAgent.ts（在 computeFactors 内调）
//   - integrations/index.ts（统一导出）
//
//   它调用：
//   - ./mbtiProfileAdapter.js → getMbtiProfile（拿 MBTI 画像）
//   - ../mbti/index.js → scoreCompat（算兼容度）
// ============================================================

import { scoreCompat, type MbtiProfile, type MbtiCompatResult } from '../mbti/index.js'
import { getMbtiProfile } from './mbtiProfileAdapter.js'

/**
 * MbtiCompatFactor — 给 MatchAgent 用的 MBTI 因子结果
 * 文件路径：server/src/integrations/matchAgentMbtiAdapter.ts → MbtiCompatFactor
 *
 * 这个结构会被挂在 MatchCandidate.mbtiCompat 上
 * 前端拿 theirsType 显示在搭子卡上（"INFJ"徽章）
 */
export interface MbtiCompatFactor {
  /** 兼容度 0-1，作为 MatchFactors.mbti 字段 */
  score: number
  /** 可解释文本，如"功能栈黄金互补（Ni+Ne），维度差异适中" */
  reason: string
  /** 3 维子分明细（功能互补/维度平衡/主导和谐） */
  detail: MbtiCompatResult['detail']
  /** 我的 MBTI 类型（'INFJ' / 'UNKNOWN'），前端可显示"你的 MBTI" */
  mineType: MbtiProfile['type']
  /** 对方的 MBTI 类型（'ENFP' / 'UNKNOWN'），搭子卡徽章用这个 */
  theirsType: MbtiProfile['type']
  /** 我的 MBTI 置信度（< 0.5 时因子会降权，前端可显示"待测准"） */
  mineConfidence: number
  /** 对方的 MBTI 置信度 */
  theirsConfidence: number
}

/**
 * computeMbtiFactor() — 算"我和某候选"的 MBTI 兼容度（MatchAgent 调用入口）
 * 文件路径：server/src/integrations/matchAgentMbtiAdapter.ts → computeMbtiFactor()
 *
 * @param myUserId     - 我的用户 ID
 * @param theirUserId  - 候选的用户 ID
 * @returns MbtiCompatFactor - 含 score + reason + 双方类型 + 子分明细
 *
 * 调用链：
 *   getMbtiProfile(myUserId)      → 我的 MBTI 画像
 *   getMbtiProfile(theirUserId)   → 对方的 MBTI 画像
 *   scoreCompat(mine, theirs)     → 兼容度计算
 *
 * 边界处理：
 *   - 任一方 UNKNOWN → scoreCompat 内部返回 0.5（中性分）
 *   - 任一方 confidence < 0.5 → scoreCompat 返回 0.55（弱中性）
 *   - 这样不会因为"对方还没聊够"被扣分，保证推荐公平
 *
 * 场景：
 *   MatchAgent.execute() 内对每个候选调用一次：
 *     const mbti = computeMbtiFactor(ctx.userId, candidate.userId)
 *     factors.mbti = mbti.score
 *     candidate.mbtiCompat = mbti
 */
export function computeMbtiFactor(
  myUserId: string,
  theirUserId: string,
): MbtiCompatFactor {
  // ① 拿双方 MBTI 画像（从 MemoryBus Layer 2 读，没有则返回 UNKNOWN）
  const mine = getMbtiProfile(myUserId)
  const theirs = getMbtiProfile(theirUserId)

  // ② 算兼容度（mbtiCompat.ts 内部处理 UNKNOWN 边界）
  const result = scoreCompat(mine, theirs)

  // ③ 打包成 MatchAgent 友好的结构
  return {
    score: result.score,
    reason: result.reason,
    detail: result.detail,
    mineType: mine.type,
    theirsType: theirs.type,
    mineConfidence: mine.confidence,
    theirsConfidence: theirs.confidence,
  }
}

/**
 * mbtiTypeColorClass() — 给前端用的"类型 → 颜色组"映射辅助函数
 * 文件路径：server/src/integrations/matchAgentMbtiAdapter.ts → mbtiTypeColorClass()
 *
 * 4 大气质类型 → CSS 变量名映射（和 web/src/assets/styles/variables.css 对齐）：
 *   NT 理性者（INTJ/INTP/ENTJ/ENTP）→ 紫   --mbti-nt
 *   NF 理想主义者（INFJ/INFP/ENFJ/ENFP）→ 绿 --mbti-nf
 *   SJ 守护者（ISTJ/ISFJ/ESTJ/ESFJ）→ 蓝   --mbti-sj
 *   SP 艺术家（ISTP/ISFP/ESTP/ESFP）→ 橙   --mbti-sp
 *   UNKNOWN → 灰（默认 --text-tertiary）
 *
 * 用法（前端）：const cls = mbtiTypeColorClass('INFJ') // → 'mbti-nf'
 * 注：这个函数的字符串返回值在前端也有镜像逻辑（MatchCard.vue 内）
 */
export function mbtiTypeColorClass(type: MbtiProfile['type']): string {
  if (type === 'UNKNOWN') return 'mbti-unknown'
  // 取第 2、3 字母判断气质组：
  //   NT → 紫色理性者
  //   NF → 绿色理想主义者
  //   SJ → 蓝色守护者
  //   SP → 橙色艺术家
  const second = type[1]  // N or S
  const third = type[2]   // T or F
  if (second === 'N' && third === 'T') return 'mbti-nt'
  if (second === 'N' && third === 'F') return 'mbti-nf'
  if (second === 'S' && third === 'J') return 'mbti-sj'
  if (second === 'S' && third === 'P') return 'mbti-sp'
  return 'mbti-unknown'
}

/**
 * mbtiTypeNickname() — 给前端搭子卡用的"类型 → 中文昵称"映射
 * 文件路径：server/src/integrations/matchAgentMbtiAdapter.ts → mbtiTypeNickname()
 *
 * 用 16 型官方中文昵称，让搭子卡更有"高级感"
 *   INTJ → 战略家   INTP → 逻辑家   ENTJ → 指挥官   ENTP → 辩论家
 *   INFJ → 提倡者   INFP → 调停者   ENFJ → 主人公   ENFP → 竞选者
 *   ISTJ → 物流师   ISFJ → 守卫者   ESTJ → 总经理   ESFJ → 执政官
 *   ISTP → 鉴赏家   ISFP → 探险家   ESTP → 企业家   ESFP → 表演者
 *   UNKNOWN → 待测
 */
export function mbtiTypeNickname(type: MbtiProfile['type']): string {
  const names: Record<Exclude<MbtiProfile['type'], 'UNKNOWN'>, string> = {
    INTJ: '战略家', INTP: '逻辑家', ENTJ: '指挥官', ENTP: '辩论家',
    INFJ: '提倡者', INFP: '调停者', ENFJ: '主人公', ENFP: '竞选者',
    ISTJ: '物流师', ISFJ: '守卫者', ESTJ: '总经理', ESFJ: '执政官',
    ISTP: '鉴赏家', ISFP: '探险家', ESTP: '企业家', ESFP: '表演者',
  }
  if (type === 'UNKNOWN') return '待测'
  return names[type] ?? '待测'
}
