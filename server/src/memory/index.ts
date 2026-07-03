// ============================================================
// index.ts — memory 模块统一出口（barrel file）
// 文件路径：server/src/memory/index.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  memory 模块对外门面——四层分层记忆 + 统一记忆总线。         ║
// ║                                                            ║
// ║  模块职责总览：                                            ║
// ║                                                            ║
// ║  ┌─────────────────────────────────────────────────────┐ ║
// ║  │  memoryTypes.ts              类型 + 权限矩阵 + 配置  │ ║
// ║  │  shortTermMemory.ts          Layer 1 短期会话记忆    │ ║
// ║  │  longTermProfileMemory.ts    Layer 2 长期画像（核心）│ ║
// ║  │  matchDecisionMemory.ts      Layer 3 匹配决策记忆    │ ║
// ║  │  interactionMemory.ts        Layer 4 撮合交互记忆    │ ║
// ║  │  memoryBus.ts                统一记忆总线（路由+权限）│ ║
// ║  └─────────────────────────────────────────────────────┘ ║
// ║                                                            ║
// ║  对外典型用法：                                            ║
// ║                                                            ║
// ║  ① ProfileAgent 写短期+长期画像：                          ║
// ║     bus.appendShortTerm('profile', userId, sid, msg)       │ ║
// ║     bus.updateLongTermProfile('profile', userId, tags)     │ ║
// ║                                                            ║
// ║  ② MatchAgent 读画像+写决策：                              ║
// ║     bus.searchByVector('match', vec, 10, excludes)         │ ║
// ║     bus.writeMatchDecision('match', entry)                 │ ║
// ║                                                            ║
// ║  ③ IceBreakerAgent 读历史+写交互：                         ║
// ║     bus.getUsedTopics('icebreaker', userId)                │ ║
// ║     bus.writeInteraction('icebreaker', entry)              │ ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

// ─── 类型导出 ───
export type {
  MemoryLayer,
  AgentId,
  MemoryEntry,
  MemoryQuery,
  MemoryPermission,
  ShortTermEntry,
  LongTermProfileEntry,
  ProfileTag,
  MatchDecisionEntry,
  InteractionEntry,
} from './memoryTypes.js'

// ─── 常量导出 ───
export {
  MEMORY_PERMISSIONS,
  MEMORY_CONFIG,
} from './memoryTypes.js'

// ─── 4 层记忆实现导出（一般不直接用，用 bus 即可）───
export { ShortTermMemory } from './shortTermMemory.js'
export { LongTermProfileMemory } from './longTermProfileMemory.js'
export { MatchDecisionMemory } from './matchDecisionMemory.js'
export { InteractionMemory } from './interactionMemory.js'

// ─── 统一记忆总线导出（核心 API）───
export { MemoryBus, globalMemoryBus } from './memoryBus.js'
