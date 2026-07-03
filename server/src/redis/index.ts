// ============================================================
// index.ts — redis 模块统一出口（barrel file）
// 文件路径：server/src/redis/index.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  redis 模块对外门面——状态持久化（跨进程/重启不丢）。        ║
// ║                                                            ║
// ║  模块职责总览：                                            ║
// ║                                                            ║
// ║  ┌─────────────────────────────────────────────────────┐ ║
// ║  │  redisClient.ts    Redis 客户端封装（懒加载+降级）   │ ║
// ║  │  stateStore.ts     持久化 MemoryBus/Blackboard/会话 │ ║
// ║  └─────────────────────────────────────────────────────┘ ║
// ║                                                            ║
// ║  对外典型用法（在 index.ts 启动文件里）：                  ║
// ║                                                            ║
// ║    import { globalRedisClient, restoreMemoryFromRedis,     │ ║
// ║             startPeriodicSave, gracefulShutdown }          │ ║
// ║      from './redis/index.js'                               │ ║
// ║                                                            ║
// ║    // 启动：                                                ║
// ║    await globalRedisClient.connect()                       │ ║
// ║    await restoreMemoryFromRedis()                          │ ║
// ║    startPeriodicSave(60)                                   │ ║
// ║                                                            ║
// ║    // 退出：                                                ║
// ║    process.on('SIGTERM', () => gracefulShutdown())         │ ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

// ─── Redis 客户端 ───
export { RedisClient, globalRedisClient } from './redisClient.js'

// ─── 状态持久化 ───
export {
  REDIS_KEYS,
  saveMemoryToRedis,
  restoreMemoryFromRedis,
  saveBlackboard,
  loadBlackboard,
  saveSession,
  loadSession,
  saveCachedConversation,
  loadCachedConversation,
  startPeriodicSave,
  stopPeriodicSave,
  gracefulShutdown,
} from './stateStore.js'

// ─── 类型导出 ───
export type { PersistedState } from './stateStore.js'
