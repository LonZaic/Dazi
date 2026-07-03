// ============================================================
// index.ts — MBTI 模块统一出口（barrel file）
// 文件路径：server/src/mbti/index.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是 MBTI 模块的"对外门面"——                          ║
// ║  外部代码只需要 import { xxx } from '../mbti/index.js'，    ║
// ║  不用关心内部文件结构。                                      ║
// ║                                                            ║
// ║  模块职责总览（"底层结合 MBTI 去算填"）：                     ║
// ║                                                            ║
// ║  ┌─────────────────────────────────────────────────────┐ ║
// ║  │  mbtiTypes.ts     类型 + 16 类功能栈静态映射表        │ ║
// ║  │  mbtiEngine.ts    4 维信号 → 类型合成 + 功能栈派生    │ ║
// ║  │  mbtiCompat.ts    两人 MBTI 兼容度（3 子分加权）      │ ║
// ║  │  mbtiExtractor.ts 双模式抽取（LLM + 关键词兜底）      │ ║
// ║  └─────────────────────────────────────────────────────┘ ║
// ║                                                            ║
// ║  对外典型用法：                                            ║
// ║                                                            ║
// ║  ① ProfileAgent 后台异步抽 MBTI：                          ║
// ║     const signals = await extract(messages)                │ ║
// ║     const next = applyDimensionPatch(oldMbti, signals)     │ ║
// ║                                                            ║
// ║  ② MatchAgent 算两人兼容度（第 6 维因子）：                  ║
// ║     const result = scoreCompat(myMbti, theirMbti)          │ ║
// ║     // result.score 是 0-1 的兼容分                        │ ║
// ║                                                            ║
// ║  ③ 启动时给新用户造空画像：                                  ║
// ║     const empty = createEmptyMbtiProfile()                 │ ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - integrations/agentMemoryAdapter.ts（chat 后台 hook 抽 MBTI）
//   - integrations/matchAgentMbtiAdapter.ts（匹配时算兼容度）
//   - memory/longTermProfileMemory.ts（MbtiProfile 是画像一部分）
//
//   它调用：
//   - ./mbtiTypes.js / ./mbtiEngine.js / ./mbtiCompat.js / ./mbtiExtractor.js
//
// ════════════════════════════════════════════════════════════
//  【为啥用 barrel file（统一出口）】
// ════════════════════════════════════════════════════════════
//   好处：
//   - 外部 import 路径稳定（'../mbti/index.js'），内部文件重组不影响外部
//   - 内部文件可以自由拆分（用户要求"能拆就拆"），对外接口不变
//   - IDE 自动补全更友好（一处 import，全部符号可见）
// ============================================================

// ─── 类型导出（让外部可以 import type 用）───
// 文件路径：server/src/mbti/index.ts
export type {
  MbtiDimension,
  MbtiPole,
  MbtiType,
  CognitiveFunction,
  FunctionStack,
  MbtiDimensionSignal,
  MbtiProfile,
  MbtiCompatResult,
} from './mbtiTypes.js'

// ─── 常量导出 ───
export {
  MBTI_TYPE_STACKS,
  DIMENSION_POLES,
  POLE_TO_DIMENSION,
  createEmptyMbtiProfile,
} from './mbtiTypes.js'

// ─── 引擎 API（4 维信号 → 类型合成 + 功能栈派生）───
export {
  applyDimensionPatch,
  deriveType,
  deriveStack,
  getDominantFunction,
  getAuxiliaryFunction,
  mergeProfileInto,
} from './mbtiEngine.js'

// ─── 兼容度 API（两人 MBTI 合拍度，MatchAgent 第 6 维因子）───
export {
  scoreCompat,
} from './mbtiCompat.js'

// ─── 抽取 API（从对话抽 MBTI 4 维信号，双模式）───
export {
  extract as extractMbtiSignals,
} from './mbtiExtractor.js'
