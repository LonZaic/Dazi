// ============================================================
// boundary.ts — 压缩边界标记（学习 ccm2 的 boundary 概念）
// 文件路径：server/src/compress/boundary.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  边界标记是一条"特殊消息"，插在摘要和最近对话之间。          ║
// ║                                                            ║
// ║  ▼▼▼ 为啥要边界标记？ ▼▼▼                                   ║
// ║    - 标记"前面的内容是摘要，后面的内容是原文"                ║
// ║    - 让 LLM 知道哪些是真实对话，哪些是压缩过的              ║
// ║    - 防止 LLM 把摘要当成真实对话引用                        ║
// ║    - 调试时一眼看出"哪条是边界"                             ║
// ║                                                            ║
// ║  ▼▼▼ ccm2 原版怎么做的 ▼▼▼                                  ║
// ║    ccm2 在 compact.ts 里用类似 [conversation compacted]    ║
// ║    的文本作为 system 消息插入，标记压缩点。                  ║
// ║    搭子改造：用 system 角色插入"会话历史摘要"标记。          ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - compress/autoCompact.ts（生成摘要消息时加边界）
//
//   它调用：
//   - ../services/llmClient.js → ChatMessage 类型
// ============================================================

import type { ChatMessage } from '../services/llmClient.js'

// 边界标记的固定文本前缀（让 LLM 一眼看出这是摘要）
//   场景：[系统：以下是之前对话的摘要，非原文]
export const BOUNDARY_PREFIX = '[系统：以下是之前对话的摘要，非原文]'
export const BOUNDARY_SUFFIX = '[系统：摘要结束，以下是最近的真实对话]'

/**
 * createSummaryBoundary() — 创建摘要边界消息（开头）
 * 文件路径：server/src/compress/boundary.ts → createSummaryBoundary()
 *
 * 把摘要内容包在 [BOUNDARY_PREFIX] 和 [BOUNDARY_SUFFIX] 之间
 * 让 LLM 明确知道这是摘要不是原文
 *
 * @param summaryText - 摘要正文
 * @returns system 消息（含边界标记 + 摘要）
 */
export function createSummaryBoundary(summaryText: string): ChatMessage {
  return {
    role: 'system',
    content: `${BOUNDARY_PREFIX}\n${summaryText}\n${BOUNDARY_SUFFIX}`,
  }
}

/**
 * isSummaryBoundary() — 判断一条消息是不是摘要边界
 * 文件路径：server/src/compress/boundary.ts → isSummaryBoundary()
 *
 * 场景：恢复会话时识别哪些是摘要消息
 */
export function isSummaryBoundary(msg: ChatMessage): boolean {
  return msg.role === 'system' && msg.content.startsWith(BOUNDARY_PREFIX)
}

/**
 * extractSummaryText() — 从边界消息里抽出摘要正文
 * 文件路径：server/src/compress/boundary.ts → extractSummaryText()
 *
 * 场景：日志展示或 debug 时用
 */
export function extractSummaryText(msg: ChatMessage): string {
  if (!isSummaryBoundary(msg)) return ''
  // 去掉前缀和后缀
  const start = BOUNDARY_PREFIX.length + 1   // +1 是换行
  const end = msg.content.length - BOUNDARY_SUFFIX.length - 1
  return msg.content.slice(start, end)
}
