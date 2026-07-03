// ============================================================
// index.ts — integrations 模块统一出口（barrel file）
// 文件路径：server/src/integrations/index.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  integrations 模块对外门面——所有适配器统一出口。           ║
// ║                                                            ║
// ║  模块职责总览：                                            ║
// ║                                                            ║
// ║  ┌─────────────────────────────────────────────────────┐ ║
// ║  │  mbtiProfileAdapter.ts    MBTI ↔ ProfileAgent 桥接  │ ║
// ║  │  agentMemoryAdapter.ts    3 Agent ↔ MemoryBus 桥接  │ ║
// ║  │  cacheLlmAdapter.ts       cache 模块 ↔ LLMClient 桥接│ ║
// ║  │  lifecycleAdapter.ts      系统启动/退出/恢复         │ ║
// ║  └─────────────────────────────────────────────────────┘ ║
// ║                                                            ║
// ║  对外典型用法：                                            ║
// ║                                                            ║
// ║  ① 启动时：                                                ║
// ║     import { initEnhancedSystem } from './integrations'    │ ║
// ║     await initEnhancedSystem()                             │ ║
// ║                                                            ║
// ║  ② routes/chat.ts 用：                                     ║
// ║     import { chatWithCache, profileAdapter,                │ ║
// ║              updateMbtiFromMessages } from '../integrations'│ ║
// ║                                                            ║
// ║  ③ routes/match.ts 用：                                    ║
// ║     import { matchAdapter } from '../integrations'         │ ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

// ─── MBTI ↔ ProfileAgent 桥接 ───
export {
  getMbtiProfile,
  updateMbtiFromMessages,
  resetMbtiProfile,
} from './mbtiProfileAdapter.js'

// ─── MBTI ↔ MatchAgent 桥接（第 6 维因子）───
export {
  computeMbtiFactor,
  mbtiTypeColorClass,
  mbtiTypeNickname,
  type MbtiCompatFactor,
} from './matchAgentMbtiAdapter.js'

// ─── 3 Agent ↔ MemoryBus 桥接 ───
export {
  profileAdapter,
  matchAdapter,
  iceBreakerAdapter,
} from './agentMemoryAdapter.js'

// ─── cache ↔ LLMClient 桥接 ───
export {
  chatWithCache,
  getConversationStats,
  clearConversation,
} from './cacheLlmAdapter.js'

// ─── 系统生命周期 ───
export {
  initEnhancedSystem,
  shutdownEnhancedSystem,
  getSystemStatus,
} from './lifecycleAdapter.js'
