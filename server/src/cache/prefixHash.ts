// ============================================================
// prefixHash.ts — 前缀指纹（SHA-256 截断）
// 文件路径：server/src/cache/prefixHash.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件给"不可变前缀"算一个指纹（hash）。                  ║
// ║                                                            ║
// ║  为啥要 hash？                                              ║
// ║  - 防止"误改前缀"——前缀改一个字，hash 就变，立刻报警        ║
// ║  - 调试用：日志里打 hash，能看出"这轮用的还是上轮的前缀吗"  ║
// ║  - 多实例一致性：多个进程算同一个 prefix 应该得到同一个 hash ║
// ║                                                            ║
// ║  ▼▼▼ 情景：第 3 轮对话，hash 怎么用 ▼▼▼                    ║
// ║                                                            ║
// ║    第 2 轮结束时：                                          ║
// ║      prefix = [System, User1, AI1]                         ║
// ║      prefixHash = 'sha256:a3f1b2c4...'                     ║
// ║                                                            ║
// ║    第 3 轮开始：                                            ║
// ║      ① User2 进 log（不进 prefix）                         ║
// ║      ② AI2 进 log（不进 prefix）                           ║
// ║      ③ 第 3 轮的 prefix 还是 [System, User1, AI1]          ║
// ║         → 重新算 hash → 'sha256:a3f1b2c4...'               ║
// ║         → 和第 2 轮一样！前缀没动，缓存能命中               ║
// ║                                                            ║
// ║    如果有人不小心改了 System 一个字：                       ║
// ║      hash 变成 'sha256:9999zzzz...'                        ║
// ║      → 立刻发现前缀被改了，缓存会 miss，省钱策略失效        ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【为啥用 SHA-256 而不是 MD5 / 简单 hash】
// ════════════════════════════════════════════════════════════
//   - SHA-256 抗碰撞（不同输入几乎不可能同 hash）
//   - Node.js crypto 内置，无需额外依赖
//   - 截断到 16 字符 hex 已经够用（碰撞概率 1/16^16 = 极小）
//   - 速度够快（消息几 KB，1ms 内算完）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - readonly 参数：纯函数，不修改入参
//   - Node.js crypto：createHash('sha256') 算 hash
//   - .digest('hex')：返回 hex 字符串
// ============================================================

import { createHash } from 'node:crypto'
import type { ChatMessage } from '../services/llmClient.js'
import { CACHE_CONFIG, type PrefixHash } from './cacheTypes.js'

/**
 * computePrefixHash() — 给一段消息数组算前缀指纹
 * 文件路径：server/src/cache/prefixHash.ts → computePrefixHash()
 *
 * 算法：
 *   1. 把每条消息序列化成 "role|content\n" 格式
 *   2. 拼成大字符串
 *   3. SHA-256 → hex → 截断到 prefixHashLength 字符
 *
 * 为啥序列化成 "role|content\n" 而不是 JSON.stringify？
 *   - JSON.stringify 顺序敏感（key 顺序变了 hash 就变）
 *   - 自定义格式可控（key 顺序固定）
 *   - 更紧凑（少了 {}"" 等符号）
 *
 * @param messages - 前缀消息数组
 * @returns PrefixHash（'sha256:' + 16 字符 hex）
 */
export function computePrefixHash(messages: readonly ChatMessage[]): PrefixHash {
  // ① 序列化：每条消息一行 "role|content"
  //   场景：[ {role:'system',content:'你是搭子'}, {role:'user',content:'你好'} ]
  //         → "system|你是搭子\nuser|你好\n"
  const serialized = messages
    .map(m => `${m.role}|${m.content}`)
    .join('\n') + '\n'   // 末尾加换行，避免空数组和单元素数组 hash 撞

  // ② SHA-256 → hex
  const fullHash = createHash('sha256').update(serialized, 'utf8').digest('hex')

  // ③ 截断到配置长度（默认 16 字符）
  //   .slice(0, n) 取前 n 个字符（hex 字符串，每个字符 4 bit）
  return `sha256:${fullHash.slice(0, CACHE_CONFIG.prefixHashLength)}`
}

/**
 * verifyPrefixStable() — 验证前缀是否稳定（hash 是否匹配）
 * 文件路径：server/src/cache/prefixHash.ts → verifyPrefixStable()
 *
 * 用途：每次发请求前自检，前缀没动才发请求
 *   场景：开发者不小心改了 system prompt，立刻发现，避免无谓 miss
 *
 * @param messages  - 当前的前缀消息
 * @param expectedHash - 期望的 hash（之前算的）
 * @returns true=前缀稳定，false=前缀被改了
 */
export function verifyPrefixStable(
  messages: readonly ChatMessage[],
  expectedHash: PrefixHash,
): boolean {
  const actual = computePrefixHash(messages)
  return actual === expectedHash
}

/**
 * describeHashChange() — 对比两个 hash，输出可读的变更描述
 * 文件路径：server/src/cache/prefixHash.ts → describeHashChange()
 *
 * 场景：日志里看到 hash 变了，想知道"是哪条消息改了"
 *   返回字符串：'前缀变更：sha256:a3f1... → sha256:9999...'
 *   如果没变：'前缀稳定'
 */
export function describeHashChange(
  oldHash: PrefixHash,
  newHash: PrefixHash,
): string {
  if (oldHash === newHash) {
    return `前缀稳定（${oldHash}）`
  }
  return `前缀变更：${oldHash} → ${newHash}（缓存将 miss）`
}
