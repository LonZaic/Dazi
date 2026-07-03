// ============================================================
// mbtiEngine.ts — MBTI 引擎（4 维信号 → 类型合成 + 功能栈派生）
// 文件路径：server/src/mbti/mbtiEngine.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是 MBTI 模块的"算力核心"——                          ║
// ║  把抽取器拿到的 4 维信号（带置信度）合成最终类型，             ║
// ║  并派生出认知功能栈。                                        ║
// ║                                                            ║
// ║  和 Dazi 已有的 profileSchema.ts 设计哲学一致：              ║
// ║  - 增量合并（applyDimensionPatch，不覆盖旧证据）             ║
// ║  - 置信度驱动（4 维都达标才出 type，否则保持 UNKNOWN）        ║
// ║  - 纯函数（无副作用，方便测试和回放）                        ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王聊了 8 句话，MBTI 引擎干了啥 ▼▼▼
//
//   老画像（昨天聊的）：
//     type:'INFJ', confidence:0.55, dimensions:[
//       {EI, I, 0.7, ['喜欢安静看书']},
//       {SN, N, 0.6, ['思考人生意义']},
//       {TF, F, 0.4, []},     ← F 偏弱，还可能变 T
//       {JP, J, 0.5, ['做计划']},
//     ]
//
//   今天新聊："和朋友有矛盾时我会先分析对错再处理"
//   抽取器产出新 patch：
//     [{dimension:'TF', pole:'T', confidence:0.6, evidence:['分析对错再处理']}]
//
//   引擎合成：
//     applyDimensionPatch(老画像, 新patch)
//       → TF 维度：原 F(0.4) vs 新 T(0.6)
//         规则：同维度不同极，置信度高的胜出（带"加权"，evidence 多的更可信）
//         → 最终 T(0.6)
//       → 4 维新极字母：I N T J
//       → type: 'INTJ'（从 INFJ 变成 INTJ！这就是增量演化的力量）
//       → confidence 重算：4 维置信度平均 = (0.7+0.6+0.6+0.5)/4 = 0.6
//       → functionStack 派生：从 MBTI_TYPE_STACKS['INTJ'] = ['Ni','Te','Fi','Se']
//
// ════════════════════════════════════════════════════════════
//  【合成规则详解】
// ════════════════════════════════════════════════════════════
//   1. 每维度独立判断极向：取该维度所有信号里"加权置信度"最高的极
//      加权 = confidence × (1 + 0.1 × evidence条数)，evidence 多的更可信
//   2. 4 维都 ≥ 阈值（默认 0.5）才合成 type，否则保持 UNKNOWN
//      避免"刚聊 2 句就硬出类型"的不靠谱
//   3. 整体 confidence = 4 维 confidence 的平均
//   4. type 一旦合成，functionStack 直接查 MBTI_TYPE_STACKS（O(1)）
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   mbtiExtractor.extract(messages)
//        │ 产出 MbtiDimensionSignal[]
//        ▼
//   mbtiEngine.applyDimensionPatch(oldProfile, signals)
//        │ 合并 + 重算 type/confidence/stack
//        ▼
//   mbtiEngine.deriveType(dimensions) / deriveStack(type)
//        │
//        ▼
//   存进 memory/longTermProfileMemory.ts
//   供 MatchAgent 经 integrations/matchAgentMbtiAdapter.ts 调用
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - mbtiExtractor.ts（合成 patch 后调 applyDimensionPatch）
//   - integrations/agentMemoryAdapter.ts（启动时从记忆恢复画像）
//   - mbtiCompat.ts（拿 functionStack 算兼容度）
//
//   它调用：
//   - ./mbtiTypes.js（类型定义 + MBTI_TYPE_STACKS 查表）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - readonly 数组参数：防止函数内篡改入参（纯函数纪律）
//   - Map<k,v>：用 Map 做分组聚合，比对象更安全（key 可任意）
//   - ?? 空值合并：a ?? b = a 是 null/undefined 时取 b
//   - Number.toFixed 不用（浮点），用 Math.round(x*100)/100 控精度
// ============================================================

import {
  type MbtiProfile,
  type MbtiDimensionSignal,
  type MbtiDimension,
  type MbtiPole,
  type MbtiType,
  type FunctionStack,
  type CognitiveFunction,
  MBTI_TYPE_STACKS,
  DIMENSION_POLES,
  createEmptyMbtiProfile,
} from './mbtiTypes.js'

// ─── 引擎参数（可调，调这里就能改"出类型的激进程度"）───
// 文件路径：server/src/mbti/mbtiEngine.ts
const ENGINE_CONFIG = {
  /** 维度置信度阈值：低于此值该维度不参与类型合成（保持 unknown） */
  dimensionConfidenceThreshold: 0.5,
  /** evidence 加权系数：每条 evidence 给 confidence 加 10% 权重（封顶 1.0） */
  evidenceWeight: 0.1,
  /** 单维度 evidence 最多保留几条（防内存膨胀） */
  maxEvidencePerDimension: 5,
} as const

/**
 * applyDimensionPatch() — 把新信号增量合并进老画像
 * 文件路径：server/src/mbti/mbtiEngine.ts → applyDimensionPatch()
 *
 * 合并规则（每维度独立处理）：
 *   - 同极新信号：confidence 取 max，evidence 累加去重
 *   - 不同极新信号：加权 confidence 高的胜出，evidence 各自保留
 *   - 信号置信度低于 0.3 直接丢（噪音）
 *
 * 合并完后重算 type / confidence / functionStack
 *
 * @param current   - 老画像（来自 longTermProfileMemory）
 * @param newSignals- 新抽取的维度信号（来自 mbtiExtractor）
 * @returns 新画像（不修改入参，纯函数）
 *
 * 设计哲学：和 profileSchema.ts 的 applyPatch 一致——增量、不覆盖、可审计
 */
export function applyDimensionPatch(
  current: MbtiProfile,
  newSignals: readonly MbtiDimensionSignal[],
): MbtiProfile {
  // ① 把老画像的 dimensions 复制成可变副本（深拷贝 evidence 数组）
  //   场景：老画像的 EI 维度 evidence=['喜欢安静看书']，要往里加新证据
  //   [...arr] 浅拷贝够用，evidence 是 string[] 不需要深拷贝
  const merged: Record<MbtiDimension, MbtiDimensionSignal> = {} as Record<MbtiDimension, MbtiDimensionSignal>
  for (const d of current.dimensions) {
    merged[d.dimension] = {
      dimension: d.dimension,
      pole: d.pole,
      confidence: d.confidence,
      evidence: [...d.evidence],   // 浅拷贝 evidence，防止共享引用
    }
  }

  // ② 逐条并入新信号
  for (const sig of newSignals) {
    // 噪音过滤：置信度低于 0.3 的信号直接丢（避免一句话反转画像）
    if (sig.confidence < 0.3) continue

    const existing = merged[sig.dimension]
    if (!existing) {
      // 该维度老画像没有（理论上不会，4 维初始化都有，但防御性编程）
      merged[sig.dimension] = {
        dimension: sig.dimension,
        pole: sig.pole,
        confidence: Math.min(1, sig.confidence),
        evidence: sig.evidence.slice(0, ENGINE_CONFIG.maxEvidencePerDimension),
      }
      continue
    }

    if (existing.pole === sig.pole) {
      // 同极：confidence 取 max，evidence 累加去重
      existing.confidence = Math.min(1, Math.max(existing.confidence, sig.confidence))
      for (const ev of sig.evidence) {
        if (ev && !existing.evidence.includes(ev)) {
          existing.evidence.push(ev)
        }
      }
      // 截断 evidence 到上限（保留最新的几条）
      if (existing.evidence.length > ENGINE_CONFIG.maxEvidencePerDimension) {
        existing.evidence = existing.evidence.slice(-ENGINE_CONFIG.maxEvidencePerDimension)
      }
    } else {
      // 不同极：加权 confidence 高的胜出
      //   加权 = confidence × (1 + 0.1 × evidence条数)
      //   例：老 I(0.7, 2 evidence) → 0.7 × 1.2 = 0.84
      //        新 E(0.6, 0 evidence) → 0.6 × 1.0 = 0.6
      //   → I 胜出（老画像 + 多证据更可信）
      const oldWeighted = existing.confidence * (1 + ENGINE_CONFIG.evidenceWeight * existing.evidence.length)
      const newWeighted = sig.confidence * (1 + ENGINE_CONFIG.evidenceWeight * sig.evidence.length)
      if (newWeighted > oldWeighted) {
        // 新极胜出：用新的极和置信度，evidence 用新的（旧的丢弃，因为极变了）
        existing.pole = sig.pole
        existing.confidence = Math.min(1, sig.confidence)
        existing.evidence = sig.evidence.slice(0, ENGINE_CONFIG.maxEvidencePerDimension)
      }
      // else：老极胜出，啥也不改
    }
  }

  // ③ 4 维信号转数组
  const dimensions: MbtiDimensionSignal[] = [
    merged.EI, merged.SN, merged.TF, merged.JP,
  ]

  // ④ 派生 type（4 维都达标才出，否则 UNKNOWN）
  const type = deriveType(dimensions)

  // ⑤ 派生 functionStack（type 确定才有）
  const functionStack = type === 'UNKNOWN' ? undefined : deriveStack(type)

  // ⑥ 重算整体 confidence = 4 维平均
  const confidence = round2(
    dimensions.reduce((s, d) => s + d.confidence, 0) / dimensions.length
  )

  return {
    type,
    confidence,
    dimensions,
    functionStack,
    updatedAt: Date.now(),
  }
}

/**
 * deriveType() — 从 4 维信号合成 4 字母类型
 * 文件路径：server/src/mbti/mbtiEngine.ts → deriveType()
 *
 * 规则：
 *   - 任一维度 confidence < 阈值 → 返回 'UNKNOWN'（避免硬出类型）
 *   - 4 维都达标 → 拼 4 字母（如 'INFJ'）
 *
 * @param dimensions - 4 维信号数组
 * @returns MbtiType | 'UNKNOWN'
 */
export function deriveType(dimensions: readonly MbtiDimensionSignal[]): MbtiType | 'UNKNOWN' {
  // 任一维度 confidence 不够 → UNKNOWN
  //   场景：小王刚聊 2 句，只有 EI 维度有信号，其他都没测出来
  //   → 不硬出类型，等更多信号
  for (const d of dimensions) {
    if (d.confidence < ENGINE_CONFIG.dimensionConfidenceThreshold) {
      return 'UNKNOWN'
    }
  }

  // 拿 4 个极字母拼字符串
  //   DIMENSION_POLES 保证 4 维顺序是 EI/SN/TF/JP（对应类型字符串 1/2/3/4 位）
  const poles = dimensions.map(d => d.pole).join('') as MbtiType
  return poles
}

/**
 * deriveStack() — 由类型查认知功能栈（O(1) 查表）
 * 文件路径：server/src/mbti/mbtiEngine.ts → deriveStack()
 *
 * @param type - 16 种类型之一
 * @returns FunctionStack [主导, 辅助, 第三, 劣势]
 */
export function deriveStack(type: MbtiType): FunctionStack {
  return MBTI_TYPE_STACKS[type]
}

/**
 * getDominantFunction() — 拿一个类型的主导功能（功能栈第 0 个）
 * 文件路径：server/src/mbti/mbtiEngine.ts → getDominantFunction()
 *
 * 主导功能是类型的"内核"，决定思维方式
 * 例：INTJ 主导 Ni（洞察长远）vs ENTP 主导 Ne（发散可能）
 */
export function getDominantFunction(type: MbtiType): CognitiveFunction {
  return MBTI_TYPE_STACKS[type][0]
}

/**
 * getAuxiliaryFunction() — 拿辅助功能（功能栈第 1 个）
 * 文件路径：server/src/mbti/mbtiEngine.ts → getAuxiliaryFunction()
 *
 * 辅助功能"平衡"主导——一内一外，避免过度偏执
 */
export function getAuxiliaryFunction(type: MbtiType): CognitiveFunction {
  return MBTI_TYPE_STACKS[type][1]
}

/**
 * mergeProfile() — 把 MBTI 画像合并进 Dazi 已有的 Profile（零侵入扩展）
 * 文件路径：server/src/mbti/mbtiEngine.ts → mergeProfile()
 *
 * 这是"零侵入"的关键——不修改 profileSchema.ts，
 * 而是把 MbtiProfile 作为一个"附属字段"挂在已有 Profile 上
 *
 * 调用方：integrations/agentMemoryAdapter.ts
 */
export function mergeProfileInto<T extends Record<string, unknown>>(
  baseProfile: T,
  mbti: MbtiProfile,
): T & { mbti?: MbtiProfile } {
  // 不修改原对象，返回新对象（纯函数）
  if (mbti.type === 'UNKNOWN' && mbti.confidence === 0) {
    // 空画像不挂，避免无意义字段
    return baseProfile
  }
  return { ...baseProfile, mbti }
}

/**
 * 工具函数：四舍五入到 2 位小数（避免浮点精度问题）
 * 文件路径：server/src/mbti/mbtiEngine.ts → round2()
 *
 * 为啥不用 toFixed(2)？toFixed 返回字符串，还要 parseFloat，啰嗦
 * Math.round(x * 100) / 100 更直接
 */
function round2(x: number): number {
  return Math.round(x * 100) / 100
}

// ─── 重导出常用工具（方便调用方一处导入）───
// 文件路径：server/src/mbti/mbtiEngine.ts
export { createEmptyMbtiProfile }
export type { MbtiDimension, MbtiPole, MbtiType } from './mbtiTypes.js'
