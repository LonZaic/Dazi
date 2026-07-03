// ============================================================
// mbtiCompat.ts — MBTI 兼容度计算（匹配师第 6 维因子）
// 文件路径：server/src/mbti/mbtiCompat.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件算"两个人格类型有多合拍"——                          ║
// ║  MatchAgent 已有 5 维（向量/兴趣/风格/时段/目标），           ║
// ║  这是第 6 维，专门看"思维方式是否互补"。                      ║
// ║                                                            ║
// ║  为啥要 3 个子分？                                          ║
// ║  - 单看"类型组合"太粗（INFJ × ENFP 一定合拍吗？）            ║
// ║  - 拆成 3 个细维度才可解释、可调参：                         ║
// ║    1. 功能栈互补（Ni+Ne 是黄金组合，Se+Si 都接地气但缺远见）  ║
// ║    2. 维度平衡（4 维全相同=无聊，全相反=冲突，适中最好）     ║
// ║    3. 主导功能和谐（都主导 Te 容易争领导权）                 ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王 INFJ × 小李 ENFP，3 维子分怎么算 ▼▼▼
//
//   ① 功能栈互补分（functionComplement）
//      小王栈：Ni Fe Ti Se
//      小李栈：Ne Fi Te Si
//      把两栈的功能"配对"（每个功能找对方栈里最互补的）：
//        Ni(收敛) ↔ Ne(发散) = 0.9（黄金互补，"洞察 × 创意"）
//        Fe(外情) ↔ Fi(内情) = 0.7（情感内外平衡）
//        Ti(内思) ↔ Te(外思) = 0.7（思考内外平衡）
//        Se(外感) ↔ Si(内感) = 0.6（感官经验互补）
//      平均 = 0.725 → functionComplement = 0.73
//
//   ② 维度平衡分（dimensionBalance）
//      小王 I N F J，小李 E N F P
//      4 维差异：I/E(异) N/N(同) F/F(同) J/P(异)
//      2 异 2 同 = 理想平衡（不无聊也不冲突）→ 0.85
//      规则：0 异 = 0.5（太一样无聊），4 异 = 0.4（太对立），
//           2 异 = 1.0（最佳），1/3 异 = 0.7
//
//   ③ 主导功能和谐分（dominantHarmony）
//      小王主导 Ni，小李主导 Ne
//      Ni + Ne 都是"直觉"功能，方向不同（收敛 vs 发散）但同源
//      → 0.86（同源不同向，互相启发但不争抢）
//      反例：双方都主导 Te → 都想当领导 → 0.4
//
//   综合 score = 0.5 × 0.73 + 0.3 × 0.85 + 0.2 × 0.86 = 0.79
//   reason = "功能栈高度互补（Ni+Ne 黄金组合），维度差异适中，主导功能同源启发"
//
// ════════════════════════════════════════════════════════════
//  【兼容度理论速成】
// ════════════════════════════════════════════════════════════
//   MBTI 圈共识：
//   - 同字母差 1-2 个：通常最合拍（足够相似又足够不同）
//   - 完全相同（4 字母全同）：合拍但容易无聊
//   - 完全相反（4 字母全反）：冲突多但成长大
//   - 主导功能互补（N+N 跨内外，或 T+F 跨内外）：黄金组合
//   - 主导功能相同且同向（都 Te 主导）：易争权
//
//   这套规则不是"算命"，是"概率倾向"——和 Dazi 的 5 维因子一样，
//   是个"加权打分"，不是"绝对判定"。
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   MatchAgent.execute()（已有 5 维计算）
//        │
//        ▼ （新增 hook，零侵入）
//   integrations/matchAgentMbtiAdapter.ts 调 scoreCompat(my, theirs)
//        │
//        ▼
//   拿到 MbtiCompatResult，把 score 作为第 6 维因子
//   综合分 = 加权（vector + interest + style + schedule + goal + mbti）
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - integrations/matchAgentMbtiAdapter.ts
//
//   它调用：
//   - ./mbtiTypes.js（CognitiveFunction 类型 + MBTI_TYPE_STACKS）
//   - ./mbtiEngine.js（deriveStack, getDominantFunction）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - readonly 参数：纯函数纪律，不修改入参
//   - Record<K, V>：以 K 为 key 的字典
//   - 联合字面量类型：让 TS 检查 switch 分支穷尽性
// ============================================================

import {
  type MbtiProfile,
  type MbtiType,
  type CognitiveFunction,
  type MbtiCompatResult,
  MBTI_TYPE_STACKS,
} from './mbtiTypes.js'
import { deriveStack, getDominantFunction } from './mbtiEngine.js'

// ─── 兼容度计算参数（可调，调这里就能改"匹配风格"）───
// 文件路径：server/src/mbti/mbtiCompat.ts
const COMPAT_CONFIG = {
  /** 3 个子分的权重（合起来 = 1.0，综合分 = 加权和） */
  weights: {
    functionComplement: 0.5,   // 功能栈互补最重要（思维方式互补）
    dimensionBalance: 0.3,     // 维度平衡次之（避免冲突/无聊）
    dominantHarmony: 0.2,      // 主导功能和谐最轻（锦上添花）
  },
  /** 维度平衡：差异个数 → 分数的映射 */
  //   0 个差异（4 维全同）：0.5（合拍但无聊）
  //   1 个差异：0.7
  //   2 个差异：1.0（最佳，相似又不同）
  //   3 个差异：0.7
  //   4 个差异（4 维全反）：0.4（冲突大但成长大）
  balanceByDiffCount: { 0: 0.5, 1: 0.7, 2: 1.0, 3: 0.7, 4: 0.4 } as const,
} as const

// ─── 认知功能互补度查表 ───
// 文件路径：server/src/mbti/mbtiCompat.ts
//   8 × 8 矩阵，对称（A 对 B 的互补度 = B 对 A 的）
//   规则：
//   - 同字母同方向（Ni+Ni）：0.5（同质，缺互补）
//   - 同字母跨方向（Ni+Ne）：0.9（黄金互补，"洞察×创意"）
//   - 跨字母跨方向（Ni+Te）：0.6（不同领域，普通互补）
//   - 同字母同极对立（Te+Ti）：0.7（思考内外平衡）
//   - 跨字母同方向（Te+Se）：0.5（都外向，缺内省）
const FUNCTION_COMPAT: Record<CognitiveFunction, Record<CognitiveFunction, number>> = {
  // ── 实感功能 ──
  Se: { Se: 0.5, Si: 0.7, Ne: 0.6, Ni: 0.55, Te: 0.5, Ti: 0.55, Fe: 0.55, Fi: 0.5 },
  Si: { Se: 0.7, Si: 0.5, Ne: 0.55, Ni: 0.6, Te: 0.55, Ti: 0.5, Fe: 0.5, Fi: 0.55 },
  // ── 直觉功能 ──
  Ne: { Se: 0.6, Si: 0.55, Ne: 0.5, Ni: 0.9, Te: 0.55, Ti: 0.5, Fe: 0.5, Fi: 0.55 },
  Ni: { Se: 0.55, Si: 0.6, Ne: 0.9, Ni: 0.5, Te: 0.5, Ti: 0.55, Fe: 0.55, Fi: 0.5 },
  // ── 思考功能 ──
  Te: { Se: 0.5, Si: 0.55, Ne: 0.55, Ni: 0.5, Te: 0.4, Ti: 0.7, Fe: 0.5, Fi: 0.55 },
  Ti: { Se: 0.55, Si: 0.5, Ne: 0.5, Ni: 0.55, Te: 0.7, Ti: 0.4, Fe: 0.55, Fi: 0.5 },
  // ── 情感功能 ──
  Fe: { Se: 0.55, Si: 0.5, Ne: 0.5, Ni: 0.55, Te: 0.5, Ti: 0.55, Fe: 0.4, Fi: 0.7 },
  Fi: { Se: 0.5, Si: 0.55, Ne: 0.55, Ni: 0.5, Te: 0.55, Ti: 0.5, Fe: 0.7, Fi: 0.4 },
}
//   特别说明：Te+Te=0.4，Fe+Fe=0.4（同主导易争权）
//   Ni+Ne=0.9，Te+Ti=0.7（同源跨向，黄金互补）

/**
 * scoreCompat() — 算两个人的 MBTI 兼容度（主入口）
 * 文件路径：server/src/mbti/mbtiCompat.ts → scoreCompat()
 *
 * @param mine     - 我的 MBTI 画像（来自长期画像记忆）
 * @param theirs   - 候选的 MBTI 画像（来自候选的画像）
 * @returns MbtiCompatResult - 含 score + reason + 3 维子分明细
 *
 * 边界处理：
 *   - 任一方 type === 'UNKNOWN' → 返回 score=0.5（中性分，不拉低也不拉高）
 *     场景：候选还没聊够，MBTI 没测出来，不能因此扣分
 *   - 任一方 confidence < 0.5 → 给中性分 + 标注"信息不足"
 */
export function scoreCompat(mine: MbtiProfile, theirs: MbtiProfile): MbtiCompatResult {
  // ─── 边界：任一方未确定类型，给中性分 0.5 ───
  //   场景：候选刚注册还没聊够，MBTI 是 UNKNOWN
  //   策略：不扣分也不加分（0.5 是中性），等更多数据
  if (mine.type === 'UNKNOWN' || theirs.type === 'UNKNOWN') {
    return {
      score: 0.5,
      reason: 'MBTI 信息不足，暂按中性分处理',
      detail: {
        functionComplement: 0.5,
        dimensionBalance: 0.5,
        dominantHarmony: 0.5,
      },
    }
  }

  // 信息不足但已知类型 → 降权（confidence < 0.5 时给中性分）
  if (mine.confidence < 0.5 || theirs.confidence < 0.5) {
    return {
      score: 0.55,
      reason: 'MBTI 置信度较低，仅供参考',
      detail: {
        functionComplement: 0.55,
        dimensionBalance: 0.55,
        dominantHarmony: 0.55,
      },
    }
  }

  const myType = mine.type as MbtiType
  const theirType = theirs.type as MbtiType

  // ① 功能栈互补分
  const functionComplement = computeFunctionComplement(myType, theirType)

  // ② 维度平衡分
  const dimensionBalance = computeDimensionBalance(myType, theirType)

  // ③ 主导功能和谐分
  const dominantHarmony = computeDominantHarmony(myType, theirType)

  // 综合 = 加权和
  const score = round2(
    COMPAT_CONFIG.weights.functionComplement * functionComplement +
    COMPAT_CONFIG.weights.dimensionBalance * dimensionBalance +
    COMPAT_CONFIG.weights.dominantHarmony * dominantHarmony
  )

  // 生成可解释文本
  const reason = buildReason(myType, theirType, {
    functionComplement, dimensionBalance, dominantHarmony,
  })

  return { score, reason, detail: { functionComplement, dimensionBalance, dominantHarmony } }
}

/**
 * computeFunctionComplement() — 功能栈互补分（0-1）
 * 文件路径：server/src/mbti/mbtiCompat.ts → computeFunctionComplement()
 *
 * 算法：
 *   - 双方功能栈各 4 个功能
 *   - 用匈牙利匹配思想简化版：每个功能找对方栈里互补度最高的配对
 *   - 4 个配对取平均
 *
 * 场景：INTJ[Ni,Te,Fi,Se] × ENFP[Ne,Fi,Te,Si]
 *   Ni ↔ Ne(0.9) ← 最佳配对
 *   Te ↔ Te(0.4) 或 Ti(0.7) ← 取 0.7
 *   Fi ↔ Fi(0.4) 或 Fe(0.7) ← 取 0.7
 *   Se ↔ Si(0.7) ← 最佳配对
 *   平均 = (0.9+0.7+0.7+0.7)/4 = 0.75
 */
function computeFunctionComplement(myType: MbtiType, theirType: MbtiType): number {
  const myStack = deriveStack(myType)
  const theirStack = deriveStack(theirType)

  let total = 0
  for (const myFunc of myStack) {
    // 找对方栈里和我的这个功能最互补的（最高分）
    let best = 0
    for (const theirFunc of theirStack) {
      const compat = FUNCTION_COMPAT[myFunc][theirFunc]
      if (compat > best) best = compat
    }
    total += best
  }
  // 4 个功能的最佳配对平均
  return round2(total / myStack.length)
}

/**
 * computeDimensionBalance() — 维度平衡分（0-1）
 * 文件路径：server/src/mbti/mbtiCompat.ts → computeDimensionBalance()
 *
 * 规则：4 维中有几个差异（极字母不同的维度数）
 *   - 0 差异（全同）：0.5（合拍但无聊）
 *   - 2 差异：1.0（最佳）
 *   - 4 差异（全反）：0.4（冲突大）
 */
function computeDimensionBalance(myType: MbtiType, theirType: MbtiType): number {
  let diffCount = 0
  for (let i = 0; i < 4; i++) {
    if (myType[i] !== theirType[i]) diffCount++
  }
  return COMPAT_CONFIG.balanceByDiffCount[diffCount as 0 | 1 | 2 | 3 | 4]
}

/**
 * computeDominantHarmony() — 主导功能和谐分（0-1）
 * 文件路径：server/src/mbti/mbtiCompat.ts → computeDominantHarmony()
 *
 * 规则：
 *   - 双方主导功能相同字母 + 跨向（Ni+Ne / Te+Ti）：0.9（黄金互补）
 *   - 双方主导功能相同字母 + 同向（Ni+Ni）：0.5（同质）
 *   - 双方主导功能跨字母（Ni+Te）：0.6（普通）
 *   - 双方主导功能相同字母 + 同向 + 同极（Te+Te）：0.4（争权）
 *
 * 实现直接查 FUNCTION_COMPAT 表（主导功能互相查）
 */
function computeDominantHarmony(myType: MbtiType, theirType: MbtiType): number {
  const myDom = getDominantFunction(myType)
  const theirDom = getDominantFunction(theirType)
  return FUNCTION_COMPAT[myDom][theirDom]
}

/**
 * buildReason() — 生成可解释文本（和 Dazi 的 buildExplanation 风格一致）
 * 文件路径：server/src/mbti/mbtiCompat.ts → buildReason()
 *
 * 不只给分数，还告诉用户"为啥合拍"——可解释匹配是 Dazi 的核心特色
 */
function buildReason(
  myType: MbtiType,
  theirType: MbtiType,
  detail: { functionComplement: number; dimensionBalance: number; dominantHarmony: number },
): string {
  const parts: string[] = []
  const myDom = getDominantFunction(myType)
  const theirDom = getDominantFunction(theirType)

  // 功能互补描述
  if (detail.functionComplement >= 0.8) {
    parts.push(`功能栈高度互补（你的${myDom}和TA的${theirDom}是黄金组合）`)
  } else if (detail.functionComplement >= 0.65) {
    parts.push(`功能栈互补良好（${myDom}×${theirDom} 思维方式互补）`)
  } else if (detail.functionComplement < 0.5) {
    parts.push(`功能栈相似度高（思维方式接近，易共鸣但可能缺新意）`)
  }

  // 维度平衡描述
  if (detail.dimensionBalance >= 0.9) {
    parts.push('维度差异适中（相似又不同，最佳平衡）')
  } else if (detail.dimensionBalance <= 0.5) {
    parts.push('维度高度相似（容易同频但也可能无聊）')
  }

  // 主导功能描述
  if (detail.dominantHarmony >= 0.85) {
    parts.push('主导功能同源启发')
  } else if (detail.dominantHarmony <= 0.45) {
    parts.push('主导功能可能争抢主导权，需多磨合')
  }

  return parts.length > 0 ? parts.join('，') : 'MBTI 维度匹配中性'
}

/**
 * round2() — 四舍五入到 2 位小数
 * 文件路径：server/src/mbti/mbtiCompat.ts → round2()
 */
function round2(x: number): number {
  return Math.round(x * 100) / 100
}

// ─── 重导出 ───
// 文件路径：server/src/mbti/mbtiCompat.ts
export { MBTI_TYPE_STACKS } from './mbtiTypes.js'
