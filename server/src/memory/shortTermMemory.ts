// ============================================================
// shortTermMemory.ts — Layer 1 短期会话记忆
// 文件路径：server/src/memory/shortTermMemory.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  Layer 1：ProfileAgent 专用，存当前会话原文 + 临时抽取信息。║
// ║                                                            ║
// ║  ▼▼▼ 情景：小王 5 轮对话，Layer 1 怎么存 ▼▼▼               ║
// ║                                                            ║
// ║    第 1 轮：append('u1:s1', {role:'user',content:'你好'})   ║
// ║      entries = [{sessionId:'u1:s1', messages:[User1]}]    ║
// ║                                                            ║
// ║    第 2 轮：append('u1:s1', {role:'assistant',content:'你好啊'})║
// ║      entries = [{sessionId:'u1:s1', messages:[User1,AI1]}]║
// ║                                                            ║
// ║    第 5 轮后：                                              ║
// ║      entries = [{sessionId:'u1:s1', messages:[User1,AI1,User2,AI2,...User5]}]║
// ║      messages 数量 = 9 条（5 user + 4 ai，AI5 还没回）     ║
// ║                                                            ║
// ║    滑动窗口：messages 超过 shortTermWindowSize(20) 时       ║
// ║      保留最近 20 条（旧消息"沉淀"到 Layer 2，这里删）       ║
// ║                                                            ║
// ║  ▼▼▼ 会话结束时怎么"沉淀"？ ▼▼▼                              ║
// ║    settleSession(userId, sessionId) → 把临时抽取信息打包    ║
// ║    传给 LongTermProfileMemory.update() 做增量合并          ║
// ║    然后清空 Layer 1 该会话的 entries                       ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - memory/memoryBus.ts（路由到本层）
//   - integrations/agentMemoryAdapter.ts（ProfileAgent 包装）
//
//   它调用：
//   - ./memoryTypes.js → ShortTermEntry, MEMORY_CONFIG
//   - ../services/llmClient.js → ChatMessage 类型
// ============================================================

import type { ChatMessage } from '../services/llmClient.js'
import {
  type ShortTermEntry,
  MEMORY_CONFIG,
} from './memoryTypes.js'

/**
 * ShortTermMemory — Layer 1 短期会话记忆实现
 * 文件路径：server/src/memory/shortTermMemory.ts → class ShortTermMemory
 *
 * 用 Map<sessionId, ShortTermEntry> 存储
 * 每个 sessionId 对应一条 entry（消息列表）
 *
 * 注意：内存存储，进程重启会丢
 * 重启后通过 redis/ 模块的 sessionStore 恢复
 */
export class ShortTermMemory {
  /** 内部存储：sessionId → entry */
  private readonly _store = new Map<string, ShortTermEntry>()

  /**
   * append() — 追加一条消息到指定会话
   * 文件路径：server/src/memory/shortTermMemory.ts → ShortTermMemory.append()
   *
   * @param userId    - 用户 ID
   * @param sessionId - 会话 ID
   * @param message   - 要追加的消息
   *
   * 规则：
   *   - 会话不存在则新建
   *   - 超过滑动窗口大小自动截断（保留最近 N 条）
   */
  append(userId: string, sessionId: string, message: ChatMessage): void {
    let entry = this._store.get(sessionId)
    if (!entry) {
      entry = {
        id: `stm-${sessionId}-${Date.now()}`,
        layer: 'short_term',
        userId,
        writerAgent: 'profile',
        timestamp: Date.now(),
        payload: {
          sessionId,
          messages: [],
        },
      }
      this._store.set(sessionId, entry)
    }

    entry.payload.messages.push(message)
    entry.timestamp = Date.now()

    // 滑动窗口：超过上限截断（保留最近 N 条）
    if (entry.payload.messages.length > MEMORY_CONFIG.shortTermWindowSize) {
      const overflow = entry.payload.messages.length - MEMORY_CONFIG.shortTermWindowSize
      entry.payload.messages.splice(0, overflow)
    }
  }

  /**
   * setTempPatch() — 设置临时抽取信息（还没沉淀到 Layer 2 的）
   * 文件路径：server/src/memory/shortTermMemory.ts → ShortTermMemory.setTempPatch()
   *
   * 场景：ProfileAgent 抽出"小王喜欢跑步"，还没合并到 Layer 2，
   *      先存 tempPatch，让 MatchAgent 在 Layer 2 没更新前也能用
   */
  setTempPatch(sessionId: string, patch: Record<string, unknown>): void {
    const entry = this._store.get(sessionId)
    if (entry) {
      entry.payload.tempPatch = patch
      entry.timestamp = Date.now()
    }
  }

  /**
   * read() — 读会话消息
   * 文件路径：server/src/memory/shortTermMemory.ts → ShortTermMemory.read()
   */
  read(sessionId: string): ShortTermEntry | null {
    return this._store.get(sessionId) ?? null
  }

  /**
   * settleAndClear() — 会话结束，沉淀临时信息并清空
   * 文件路径：server/src/memory/shortTermMemory.ts → ShortTermMemory.settleAndClear()
   *
   * @param sessionId - 要结束的会话 ID
   * @returns 该会话的完整 entry（含 messages + tempPatch），调用方拿去喂 Layer 2
   *
   * 流程：
   *   1. 取出 entry
   *   2. 从内存删除（Layer 1 不再保留）
   *   3. 返回 entry 给调用方（LongTermProfileMemory.update() 用）
   */
  settleAndClear(sessionId: string): ShortTermEntry | null {
    const entry = this._store.get(sessionId)
    if (!entry) return null
    this._store.delete(sessionId)
    return entry
  }

  /**
   * serialize() — 序列化（存 Redis 用）
   * 文件路径：server/src/memory/shortTermMemory.ts → ShortTermMemory.serialize()
   *
   * 场景：进程重启前持久化所有会话
   */
  serialize(): string {
    return JSON.stringify(Array.from(this._store.entries()))
  }

  /**
   * restore() — 反序列化恢复（从 Redis 加载）
   * 文件路径：server/src/memory/shortTermMemory.ts → ShortTermMemory.restore()
   *
   * 场景：进程重启后恢复所有会话
   */
  restore(serialized: string): void {
    try {
      const arr = JSON.parse(serialized) as [string, ShortTermEntry][]
      this._store.clear()
      for (const [k, v] of arr) {
        this._store.set(k, v)
      }
    } catch {
      // 恢复失败忽略（空状态启动）
    }
  }
}
