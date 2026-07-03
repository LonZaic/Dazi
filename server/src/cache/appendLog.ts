// ============================================================
// appendLog.ts — 只追加日志（append-only log，禁止修改/删除）
// 文件路径：server/src/cache/appendLog.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这是 Reasonix 省钱策略的核心数据结构——                      ║
// ║  一个"只能往末尾加，不能改不能删"的消息日志。                 ║
// ║                                                            ║
// ║  为啥要禁止修改？                                           ║
// ║  - DeepSeek 前缀缓存是"字节级"匹配                          ║
// ║  - 改了第 3 条消息，从第 3 条开始全部 miss                   ║
// ║  - 删了第 5 条消息，从第 5 条开始全部 miss                   ║
// ║  - 只追加才能保证前面的字节序列永远不变                      ║
// ║                                                            ║
// ║  ▼▼▼ 情景：第 3 轮对话，appendLog 怎么用 ▼▼▼               ║
// ║                                                            ║
// ║    第 1 轮：append('user', '你好')                          ║
// ║      log = [user:你好]                                     ║
// ║      发请求时 prefix=[System] + log=[user:你好]            ║
// ║                                                            ║
// ║    第 1 轮 AI 回复：append('assistant', '你好啊')           ║
// ║      log = [user:你好, assistant:你好啊]                    ║
// ║                                                            ║
// ║    第 2 轮：append('user', '今天干嘛')                      ║
// ║      log = [user:你好, assistant:你好啊, user:今天干嘛]     ║
// ║      发请求时 prefix=[System] + log（3条）                  ║
// ║      → DeepSeek 发现 [System, user:你好, assistant:你好啊]  ║
// ║        部分命中缓存，只为 user:今天干嘛 付全价              ║
// ║                                                            ║
// ║  ▼▼▼ 为啥不能改 user:你好 为 user:嗨？ ▼▼▼                ║
// ║    改了之后：                                               ║
// ║      log = [user:嗨, assistant:你好啊, user:今天干嘛]       ║
// ║      → 整条 log 全部 miss（因为前缀全变了）                 ║
// ║      → 省 0 元，比上一轮多花 3 倍                          ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【设计原则】
// ════════════════════════════════════════════════════════════
//   - append() 是唯一公开的修改方法
//   - 没有 update/delete/insert 方法（API 层面禁止修改）
//   - 内部数组用 readonly 暴露给外部读取
//   - 想截断旧消息？必须用 compress 模块的"摘要+替换"流程
//     （那是个新前缀，不是修改）
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - cache/cacheClient.ts（管理会话的 log 部分）
//   - integrations/llmClientCacheAdapter.ts（包装现有 chat 流程）
//
//   它调用：
//   - ../services/llmClient.js → ChatMessage 类型
//   - ./cacheTypes.js → MessageRole 类型
// ============================================================

import type { ChatMessage } from '../services/llmClient.js'
import type { MessageRole } from './cacheTypes.js'
import { CACHE_CONFIG } from './cacheTypes.js'

/**
 * AppendOnlyLog — 只追加日志类
 * 文件路径：server/src/cache/appendLog.ts → class AppendOnlyLog
 *
 * 不直接暴露数组，强制通过 append() 方法追加
 * 这样调用方无法绕过 API 直接 splice/push/修改
 *
 * 场景：
 *   const log = new AppendOnlyLog()
 *   log.append('user', '你好')           // ✅ 允许
 *   log.append('assistant', '你好啊')    // ✅ 允许
 *   log.update(0, 'user', '嗨')          // ❌ 方法不存在
 *   log.delete(0)                        // ❌ 方法不存在
 *   log.messages[0].content = '嗨'       // ⚠️ 类型 readonly，TS 报错
 */
export class AppendOnlyLog {
  /** 内部可变数组（不对外暴露，外部只能通过 asReadonly() 读） */
  private readonly _messages: ChatMessage[] = []

  /**
   * append() — 追加一条消息（唯一公开的修改方法）
   * 文件路径：server/src/cache/appendLog.ts → AppendOnlyLog.append()
   *
   * @param role    - 消息角色
   * @param content - 消息内容
   * @returns 追加后的消息总数（方便外部判断是否触发压缩）
   *
   * 规则：
   *   - content 为空字符串直接拒绝（避免空消息污染前缀）
   *   - 超过 maxLogMessages 时只追加不删（删是 compress 模块的活）
   *     返回值让调用方决定是否触发压缩
   */
  append(role: MessageRole, content: string): number {
    if (!content || content.trim().length === 0) {
      // 空消息拒绝追加（避免无意义 token 消耗）
      return this._messages.length
    }
    this._messages.push({ role, content })
    return this._messages.length
  }

  /**
   * asReadonly() — 以只读视图暴露内部消息
   * 文件路径：server/src/cache/appendLog.ts → AppendOnlyLog.asReadonly()
   *
   * 返回 readonly ChatMessage[]，TS 层面禁止修改
   * 注意：JS 运行时仍可改（readonly 只是 TS 编译期检查），
   *       但调用方遵守 TS 类型就不会改
   */
  asReadonly(): readonly ChatMessage[] {
    return this._messages as readonly ChatMessage[]
  }

  /**
   * size() — 当前消息数
   * 文件路径：server/src/cache/appendLog.ts → AppendOnlyLog.size()
   */
  size(): number {
    return this._messages.length
  }

  /**
   * shouldCompact() — 是否应该触发压缩
   * 文件路径：server/src/cache/appendLog.ts → AppendOnlyLog.shouldCompact()
   *
   * 超过 maxLogMessages 时返回 true，由 cacheClient 决定是否调 compress 模块
   *
   * 压缩流程（不在本文件，在 compress/ 模块）：
   *   1. 取 log 的前 N 条做摘要
   *   2. 摘要 + 剩余消息组成"新前缀"
   *   3. 这个新前缀的 hash 不同（因为是新的）
   *   4. 后续对话基于新前缀继续缓存
   */
  shouldCompact(): boolean {
    return this._messages.length > CACHE_CONFIG.maxLogMessages
  }

  /**
   * snapshot() — 拷贝一份消息数组（深拷贝）
   * 文件路径：server/src/cache/appendLog.ts → AppendOnlyLog.snapshot()
   *
   * 场景：序列化到 Redis 时需要拷贝（避免外部修改影响内部）
   */
  snapshot(): ChatMessage[] {
    return this._messages.map(m => ({ ...m }))
  }

  /**
   * restoreFromSnapshot() — 从快照恢复（仅用于 Redis 重启恢复）
   * 文件路径：server/src/cache/appendLog.ts → AppendOnlyLog.restoreFromSnapshot()
   *
   * 这是 append() 之外唯一能改内部状态的方法
   * 但它是"批量恢复"，不是"修改单条"，符合 append-only 语义
   *
   * 场景：进程重启后从 Redis 恢复会话状态
   */
  restoreFromSnapshot(messages: readonly ChatMessage[]): void {
    // 清空再批量塞入（恢复语义，不算"修改"）
    this._messages.length = 0
    for (const m of messages) {
      this._messages.push({ ...m })
    }
  }
}
