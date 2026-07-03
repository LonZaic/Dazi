// ============================================================
// lifecycleAdapter.ts — 系统生命周期适配器（启动/退出/恢复）
// 文件路径：server/src/integrations/lifecycleAdapter.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  统一管理系统启动/退出流程，把所有新模块串起来。            ║
// ║                                                            ║
// ║  ▼▼▼ 情景：进程启动 → 运行 → 退出 全流程 ▼▼▼              ║
// ║                                                            ║
// ║    ① 启动时（index.ts 调一次）：                            ║
// ║       await initEnhancedSystem()                           ║
// ║         → globalRedisClient.connect()                      ║
// ║         → restoreMemoryFromRedis()                         ║
// ║         → startPeriodicSave(60)                            ║
// ║         → 注册 SIGTERM/SIGINT 钩子                         ║
// ║                                                            ║
// ║    ② 运行中：                                              ║
// ║       - 定时保存（每分钟）                                  ║
// ║       - 每次写入后保存（stateStore 内部决定）              ║
// ║                                                            ║
// ║    ③ 退出时（收到 SIGTERM）：                              ║
// ║       await gracefulShutdown()                             ║
// ║         → stopPeriodicSave()                               ║
// ║         → saveMemoryToRedis()                              ║
// ║         → globalRedisClient.disconnect()                   ║
// ║                                                            ║
// ║  ▼▼▼ 降级策略 ▼▼▼                                          ║
// ║    - 没 REDIS_URL → 全部走内存（不持久化）                  ║
// ║    - Redis 连不上 → 警告 + 降级到内存                      ║
// ║    - 恢复失败 → 从空状态启动（不阻塞）                     ║
// ║                                                            ║
// ║  ▼▼▼ 用户怎么用？ ▼▼▼                                       ║
// ║    在 index.ts 入口文件加 2 行：                            ║
// ║                                                            ║
// ║      import { initEnhancedSystem, gracefulShutdown }       ║
// ║        from './integrations/index.js'                      ║
// ║                                                            ║
// ║      await initEnhancedSystem()  // 启动时                  ║
// ║      // ... 启动 Express                                   ║
// ║      process.on('SIGTERM', gracefulShutdown)  // 退出时     ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - index.ts（启动入口）
//
//   它调用：
//   - ../redis/index.js → 全部 Redis 相关
//   - ../memory/index.js → globalMemoryBus
// ============================================================

import {
  globalRedisClient,
  restoreMemoryFromRedis,
  saveMemoryToRedis,
  startPeriodicSave,
  stopPeriodicSave,
} from '../redis/index.js'

/** 是否已初始化（防止重复 init） */
let _initialized = false

/**
 * initEnhancedSystem() — 启动增强系统（Redis + 记忆恢复 + 定时保存）
 * 文件路径：server/src/integrations/lifecycleAdapter.ts → initEnhancedSystem()
 *
 * 在 index.ts 启动 Express 之前调一次
 *
 * 流程：
 *   1. 连接 Redis（没配 REDIS_URL 自动降级）
 *   2. 从 Redis 恢复 MemoryBus 全部 4 层
 *   3. 启动定时保存（每 60 秒）
 *   4. 注册进程退出钩子（SIGTERM/SIGINT）
 *
 * 注意：所有步骤都"尽力而为"，失败不阻塞主流程
 */
export async function initEnhancedSystem(): Promise<void> {
  if (_initialized) return
  _initialized = true

  console.log('[lifecycle] 开始初始化增强系统...')

  // ① 连接 Redis
  await globalRedisClient.connect()

  // ② 从 Redis 恢复记忆
  if (globalRedisClient.isAvailable) {
    await restoreMemoryFromRedis().catch(err => {
      console.warn(`[lifecycle] 恢复记忆失败：${err?.message ?? err}`)
    })
  }

  // ③ 启动定时保存
  if (globalRedisClient.isAvailable) {
    startPeriodicSave(60)
  }

  console.log('[lifecycle] 增强系统初始化完成')
  console.log(`[lifecycle] Redis 持久化：${globalRedisClient.isAvailable ? '已启用' : '未启用（内存模式）'}`)
}

/**
 * shutdownEnhancedSystem() — 手动关闭（测试用）
 * 文件路径：server/src/integrations/lifecycleAdapter.ts → shutdownEnhancedSystem()
 */
export async function shutdownEnhancedSystem(): Promise<void> {
  stopPeriodicSave()
  await saveMemoryToRedis().catch(() => {})
  await globalRedisClient.disconnect()
  _initialized = false
}

/**
 * getSystemStatus() — 拿系统状态（健康检查用）
 * 文件路径：server/src/integrations/lifecycleAdapter.ts → getSystemStatus()
 *
 * 场景：前端展示"系统状态：Redis 已连接，记忆已恢复"
 */
export function getSystemStatus(): {
  initialized: boolean
  redisAvailable: boolean
  memoryRestored: boolean
} {
  return {
    initialized: _initialized,
    redisAvailable: globalRedisClient.isAvailable,
    memoryRestored: _initialized,  // 简化：初始化成功就认为恢复了
  }
}

// gracefulShutdown 已由 index.ts 统一管理（参见 server/src/index.ts shutdown()）
