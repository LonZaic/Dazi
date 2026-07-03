// ============================================================
// stateStore.ts — 状态持久化（MemoryBus 跨进程/重启不丢）
// 文件路径：server/src/redis/stateStore.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  把 MemoryBus 的 4 层记忆 + Blackboard 持久化到 Redis。     ║
// ║                                                            ║
// ║  ▼▼▼ 情景：进程崩溃 → 重启 → 状态恢复 ▼▼▼                  ║
// ║                                                            ║
// ║    运行中（每分钟定时 + 每次写入后）：                       ║
// ║      saveMemoryToRedis()                                   ║
// ║        → globalMemoryBus.serializeAll()                    ║
// ║        → globalRedisClient.setJSON('memory:all', data)     ║
// ║                                                            ║
// ║    进程崩溃：                                               ║
// ║      内存里的 MemoryBus 全没了                              ║
// ║      但 Redis 里 memory:all 还在                           ║
// ║                                                            ║
// ║    重启后（启动时调一次）：                                  ║
// ║      restoreMemoryFromRedis()                              ║
// ║        → globalRedisClient.getJSON('memory:all')           ║
// ║        → globalMemoryBus.restoreAll(data)                  ║
// ║      → 4 层记忆全回来了                                     ║
// ║                                                            ║
// ║  ▼▼▼ 持久化策略 ▼▼▼                                         ║
// ║                                                            ║
// ║    ① 全量快照（每 N 秒）：                                  ║
// ║       存 memory:all，覆盖写                                 ║
// ║                                                            ║
// ║    ② 增量写入（每次更新后）：                               ║
// ║       存 memory:delta:{timestamp}，TTL 1 小时              ║
// ║       重启时合并全量+增量（节省 Redis 内存）                ║
// ║                                                            ║
// ║    简化版：只做全量快照（够用，后期可扩展增量）              ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - integrations/lifecycleAdapter.ts（定时保存+启动恢复）
//   - index.ts（启动时恢复）
//
//   它调用：
//   - ./redisClient.js → globalRedisClient
//   - ../memory/index.js → globalMemoryBus
// ============================================================

import { globalRedisClient } from './redisClient.js'
import { globalMemoryBus } from '../memory/index.js'
import type { BlackboardSnapshot } from '../core/blackboard.js'

/** Redis Key 常量 */
export const REDIS_KEYS = {
  /** 全部 4 层记忆 */
  memoryAll: 'memory:all',
  /** 用户黑板快照前缀（拼 userId） */
  blackboardPrefix: 'blackboard:',
  /** 会话状态前缀（拼 sessionId） */
  sessionPrefix: 'session:',
  /** CachedConversation 前缀 */
  cacheConvPrefix: 'cache:conv:',
} as const

/** 持久化数据结构 */
export interface PersistedState {
  memory: {
    shortTerm: string
    longTermProfile: string
    matchDecision: string
    interaction: string
  }
  savedAt: number
  version: string
}

// ─── MemoryBus 持久化 ───

/**
 * saveMemoryToRedis() — 把 MemoryBus 全部状态存到 Redis
 * 文件路径：server/src/redis/stateStore.ts → saveMemoryToRedis()
 *
 * 场景：定时任务调（每分钟）+ 每次重要写入后调
 */
export async function saveMemoryToRedis(): Promise<boolean> {
  if (!globalRedisClient.isAvailable) return false

  const data: PersistedState = {
    memory: globalMemoryBus.serializeAll(),
    savedAt: Date.now(),
    version: '1.0',
  }

  return globalRedisClient.setJSON(REDIS_KEYS.memoryAll, data)
}

/**
 * restoreMemoryFromRedis() — 从 Redis 恢复 MemoryBus
 * 文件路径：server/src/redis/stateStore.ts → restoreMemoryFromRedis()
 *
 * 场景：进程启动时调一次
 */
export async function restoreMemoryFromRedis(): Promise<boolean> {
  if (!globalRedisClient.isAvailable) return false

  const data = await globalRedisClient.getJSON<PersistedState>(REDIS_KEYS.memoryAll)
  if (!data) {
    console.log('[stateStore] Redis 里没有记忆数据，从空状态启动')
    return false
  }

  globalMemoryBus.restoreAll(data.memory)
  console.log(`[stateStore] 从 Redis 恢复记忆（保存于 ${new Date(data.savedAt).toLocaleString()}）`)
  return true
}

// ─── Blackboard 持久化 ───

/**
 * saveBlackboard() — 把单个用户的黑板存到 Redis
 * 文件路径：server/src/redis/stateStore.ts → saveBlackboard()
 *
 * @param userId   - 用户 ID
 * @param snapshot - 黑板快照
 */
export async function saveBlackboard(
  userId: string,
  snapshot: BlackboardSnapshot,
): Promise<boolean> {
  if (!globalRedisClient.isAvailable) return false
  return globalRedisClient.setJSON(
    `${REDIS_KEYS.blackboardPrefix}${userId}`,
    snapshot,
  )
}

/**
 * loadBlackboard() — 从 Redis 读用户黑板
 * 文件路径：server/src/redis/stateStore.ts → loadBlackboard()
 */
export async function loadBlackboard(
  userId: string,
): Promise<BlackboardSnapshot | null> {
  if (!globalRedisClient.isAvailable) return null
  return globalRedisClient.getJSON<BlackboardSnapshot>(
    `${REDIS_KEYS.blackboardPrefix}${userId}`,
  )
}

// ─── 会话状态持久化 ───

/**
 * saveSession() — 存会话状态（如 sessionId → userId 映射、创建时间）
 * 文件路径：server/src/redis/stateStore.ts → saveSession()
 *
 * @param sessionId  - 会话 ID
 * @param state      - 会话状态对象
 * @param ttlSec     - 过期时间（秒），默认 24 小时
 */
export async function saveSession(
  sessionId: string,
  state: Record<string, unknown>,
  ttlSec: number = 86400,
): Promise<boolean> {
  if (!globalRedisClient.isAvailable) return false
  return globalRedisClient.setJSON(
    `${REDIS_KEYS.sessionPrefix}${sessionId}`,
    { ...state, savedAt: Date.now() },
    ttlSec,
  )
}

/**
 * loadSession() — 读会话状态
 * 文件路径：server/src/redis/stateStore.ts → loadSession()
 */
export async function loadSession<T = Record<string, unknown>>(
  sessionId: string,
): Promise<T | null> {
  if (!globalRedisClient.isAvailable) return null
  return globalRedisClient.getJSON<T>(
    `${REDIS_KEYS.sessionPrefix}${sessionId}`,
  )
}

// ─── CachedConversation 持久化 ───

/**
 * saveCachedConversation() — 存缓存对话（cache 模块用）
 * 文件路径：server/src/redis/stateStore.ts → saveCachedConversation()
 *
 * 场景：cache/cacheClient.ts 每次对话后调这个持久化
 */
export async function saveCachedConversation(
  convId: string,
  serialized: string,
  ttlSec: number = 86400,
): Promise<boolean> {
  if (!globalRedisClient.isAvailable) return false
  return globalRedisClient.setJSON(
    `${REDIS_KEYS.cacheConvPrefix}${convId}`,
    { serialized, savedAt: Date.now() },
    ttlSec,
  )
}

/**
 * loadCachedConversation() — 读缓存对话
 * 文件路径：server/src/redis/stateStore.ts → loadCachedConversation()
 */
export async function loadCachedConversation(
  convId: string,
): Promise<string | null> {
  if (!globalRedisClient.isAvailable) return null
  const data = await globalRedisClient.getJSON<{ serialized: string }>(
    `${REDIS_KEYS.cacheConvPrefix}${convId}`,
  )
  return data?.serialized ?? null
}

// ─── 定时保存 ───

/** 定时器引用（停止时用） */
let _saveTimer: NodeJS.Timeout | null = null

/**
 * startPeriodicSave() — 启动定时保存任务
 * 文件路径：server/src/redis/stateStore.ts → startPeriodicSave()
 *
 * @param intervalSec - 间隔秒数，默认 60 秒
 *
 * 场景：index.ts 启动时调一次
 */
export function startPeriodicSave(intervalSec: number = 60): void {
  if (_saveTimer) return
  _saveTimer = setInterval(async () => {
    await saveMemoryToRedis().catch(() => {})
  }, intervalSec * 1000)
  console.log(`[stateStore] 定时保存已启动（每 ${intervalSec} 秒）`)
}

/**
 * stopPeriodicSave() — 停止定时保存（进程退出前调）
 * 文件路径：server/src/redis/stateStore.ts → stopPeriodicSave()
 */
export function stopPeriodicSave(): void {
  if (_saveTimer) {
    clearInterval(_saveTimer)
    _saveTimer = null
    console.log('[stateStore] 定时保存已停止')
  }
}

/**
 * gracefulShutdown() — 优雅关闭（保存最后状态 + 断开连接）
 * 文件路径：server/src/redis/stateStore.ts → gracefulShutdown()
 *
 * 场景：进程收到 SIGTERM/SIGINT 时调
 */
export async function gracefulShutdown(): Promise<void> {
  console.log('[stateStore] 开始优雅关闭...')
  stopPeriodicSave()
  await saveMemoryToRedis().catch(() => {})
  await globalRedisClient.disconnect()
  console.log('[stateStore] 优雅关闭完成')
}
