// ============================================================
// redisClient.ts — Redis 客户端封装（可选启用）
// 文件路径：server/src/server/src/redis/redisClient.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  把 node-redis 包成可选单例，统一管理连接+健康检查。       ║
// ║                                                            ║
// ║  ▼▼▼ 为什么"可选"？ ▼▼▼                                     ║
// ║    - 开发环境可能没装 Redis，照样能跑（内存模式）           ║
// ║    - 生产环境配上 REDIS_URL 就启用                          ║
// ║    - 启用失败不抛错，自动降级到内存模式                    ║
// ║                                                            ║
// ║  ▼▼▼ 情景：进程重启不丢数据 ▼▼▼                            ║
// ║                                                            ║
// ║    启动时：                                                ║
// ║      ① redisClient.connect()                              ║
// ║      ② 如果连上：标记 isAvailable=true                     ║
// ║      ③ 连不上：标记 isAvailable=false，降级到内存          ║
// ║                                                            ║
// ║    写入时（MemoryBus.serializeAll → redisClient.setJSON）：║
// ║      if (redisClient.isAvailable) {                        ║
// ║        await redisClient.setJSON('memory:all', data)       ║
// ║      }                                                     ║
// ║                                                            ║
// ║    进程崩溃 → Redis 里还存着 memory:all                    ║
// ║                                                            ║
// ║    重启后：                                                ║
// ║      ① redisClient.connect()                              ║
// ║      ② const data = await redisClient.getJSON('memory:all')║
// ║      ③ globalMemoryBus.restoreAll(data) → 恢复全部 4 层    ║
// ║                                                            ║
// ║  ▼▼▼ Redis Key 命名约定 ▼▼▼                                ║
// ║                                                            ║
// ║    memory:all        → 全部 4 层记忆的序列化               ║
// ║    session:{sid}     → 单个会话状态                        ║
// ║    blackboard:{uid}  → 用户的黑板快照                      ║
// ║    cache:conv:{cid}  → CachedConversation                  ║
// ║    ratelimit:{uid}   → 限流计数器                          ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - ./stateStore.ts（持久化 MemoryBus）
//   - ./sessionStore.ts（持久化会话）
//   - integrations/lifecycleAdapter.ts
//
//   它调用：
//   - redis 包（动态 import，未装则降级）
// ============================================================

import { config } from '../config/index.js'

/**
 * RedisClient — Redis 客户端封装
 * 文件路径：server/src/redis/redisClient.ts → class RedisClient
 *
 * 设计：
 *   - 懒加载（首次用时才 import redis 包）
 *   - 自动重连
 *   - 失败降级（isAvailable=false 时所有操作返回 null）
 */
export class RedisClient {
  /** 实际的 redis 客户端（连上后才有值） */
  private _client: any = null
  /** 是否可用（连上=true，没连/降级=false） */
  private _isAvailable = false
  /** 是否已初始化（防止重复 connect） */
  private _initialized = false

  /**
   * isAvailable — getter，外部判断是否走 Redis
   * 文件路径：server/src/redis/redisClient.ts → RedisClient.isAvailable
   */
  get isAvailable(): boolean {
    return this._isAvailable
  }

  /**
   * connect() — 连接 Redis（启动时调一次）
   * 文件路径：server/src/redis/redisClient.ts → RedisClient.connect()
   *
   * 流程：
   *   1. 没配 REDIS_URL → 直接返回（降级模式）
   *   2. 动态 import redis 包（没装也不报错）
   *   3. 创建客户端并连接
   *   4. 连上 → isAvailable=true；连不上 → 降级
   */
  async connect(): Promise<void> {
    if (this._initialized) return
    this._initialized = true

    const url = process.env.REDIS_URL
    if (!url) {
      console.log('[redis] 未配置 REDIS_URL，使用内存模式（不持久化）')
      return
    }

    try {
      // 动态 import，没装 redis 包也不报错
      const redisPkg = await import('redis')
      this._client = redisPkg.createClient({ url })

      this._client.on('error', (err: Error) => {
        console.warn('[redis] 连接错误，降级到内存模式：', err.message)
        this._isAvailable = false
      })

      this._client.on('reconnecting', () => {
        console.log('[redis] 尝试重连...')
      })

      await this._client.connect()
      this._isAvailable = true
      console.log('[redis] 已连接，启用持久化模式')
    } catch (err: any) {
      console.warn(`[redis] 连接失败（${err?.message ?? err}），降级到内存模式`)
      this._isAvailable = false
      this._client = null
    }
  }

  /**
   * disconnect() — 关闭连接（进程退出前调）
   * 文件路径：server/src/redis/redisClient.ts → RedisClient.disconnect()
   */
  async disconnect(): Promise<void> {
    if (this._client) {
      try {
        await this._client.quit()
      } catch {
        // 忽略关闭错误
      }
      this._client = null
      this._isAvailable = false
    }
  }

  /**
   * setJSON() — 存 JSON 对象
   * 文件路径：server/src/redis/redisClient.ts → RedisClient.setJSON()
   *
   * @param key     - Redis key
   * @param value   - 要存的值（自动 JSON.stringify）
   * @param ttlSec  - 过期时间（秒），0=不过期
   */
  async setJSON(key: string, value: unknown, ttlSec: number = 0): Promise<boolean> {
    if (!this._isAvailable || !this._client) return false
    try {
      const json = JSON.stringify(value)
      if (ttlSec > 0) {
        await this._client.set(key, json, { EX: ttlSec })
      } else {
        await this._client.set(key, json)
      }
      return true
    } catch (err: any) {
      console.warn(`[redis] setJSON(${key}) 失败：${err?.message ?? err}`)
      return false
    }
  }

  /**
   * getJSON() — 取 JSON 对象
   * 文件路径：server/src/redis/redisClient.ts → RedisClient.getJSON()
   *
   * @param key - Redis key
   * @returns 解析后的对象，不存在/失败返回 null
   */
  async getJSON<T = unknown>(key: string): Promise<T | null> {
    if (!this._isAvailable || !this._client) return null
    try {
      const json = await this._client.get(key)
      if (!json) return null
      return JSON.parse(json) as T
    } catch (err: any) {
      console.warn(`[redis] getJSON(${key}) 失败：${err?.message ?? err}`)
      return null
    }
  }

  /**
   * del() — 删除 key
   * 文件路径：server/src/redis/redisClient.ts → RedisClient.del()
   */
  async del(key: string): Promise<boolean> {
    if (!this._isAvailable || !this._client) return false
    try {
      await this._client.del(key)
      return true
    } catch {
      return false
    }
  }

  /**
   * exists() — 检查 key 是否存在
   * 文件路径：server/src/redis/redisClient.ts → RedisClient.exists()
   */
  async exists(key: string): Promise<boolean> {
    if (!this._isAvailable || !this._client) return false
    try {
      const r = await this._client.exists(key)
      return r > 0
    } catch {
      return false
    }
  }

  /**
   * incrWithTTL() — 自增计数器 + 设置 TTL（限流用）
   * 文件路径：server/src/redis/redisClient.ts → RedisClient.incrWithTTL()
   *
   * @param key     - 计数器 key
   * @param ttlSec  - 过期时间（秒）
   * @returns 自增后的值
   *
   * 场景：限流计数器，第一次调用 incr 时同时设置 TTL
   */
  async incrWithTTL(key: string, ttlSec: number): Promise<number> {
    if (!this._isAvailable || !this._client) return 0
    try {
      const count = await this._client.incr(key)
      if (count === 1) {
        // 第一次设置时才设 TTL（避免每次刷新）
        await this._client.expire(key, ttlSec)
      }
      return count
    } catch {
      return 0
    }
  }
}

/**
 * 全局单例
 * 文件路径：server/src/redis/redisClient.ts → globalRedisClient
 *
 * 用法：
 *   import { globalRedisClient } from '../redis/index.js'
 *   await globalRedisClient.connect()
 *   if (globalRedisClient.isAvailable) { ... }
 */
export const globalRedisClient = new RedisClient()
