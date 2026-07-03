// ============================================================
// index.ts — cache 模块统一出口（barrel file）
// 文件路径：server/src/cache/index.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  cache 模块对外门面——Reasonix 风格缓存前置 LLM 客户端。     ║
// ║                                                            ║
// ║  模块职责总览（"只从后面增加，省 token"）：                  ║
// ║                                                            ║
// ║  ┌─────────────────────────────────────────────────────┐ ║
// ║  │  cacheTypes.ts    类型契约 + CACHE_CONFIG 参数       │ ║
// ║  │  prefixHash.ts    SHA-256 前缀指纹（防误改）         │ ║
// ║  │  appendLog.ts     只追加日志（禁止修改/删除）        │ ║
// ║  │  cacheStats.ts    命中统计（监控省钱效果）           │ ║
// ║  │  cacheClient.ts   主 API（chatStreamCached 等）      │ ║
// ║  └─────────────────────────────────────────────────────┘ ║
// ║                                                            ║
// ║  对外典型用法：                                            ║
// ║                                                            ║
// ║  ① 创建会话缓存视图：                                       ║
// ║     const conv = createCachedConversation('u1:s1', [       │ ║
// ║       { role:'system', content:'你是搭子...' },            │ ║
// ║     ])                                                     │ ║
// ║                                                            ║
// ║  ② 用户消息进 log：                                        ║
// ║     appendUserMessage(conv, '你好')                        │ ║
// ║                                                            ║
// ║  ③ 流式对话（自动管理缓存）：                                ║
// ║     await chatStreamCached(conv, {                         │ ║
// ║       onDelta: t => sse(res, 'delta', { text: t }),        │ ║
// ║       onUsage: u => console.log(u.promptCacheHitTokens),   │ ║
// ║     })                                                     │ ║
// ║                                                            ║
// ║  ④ 查缓存统计：                                            ║
// ║     console.log(formatStatsReport(conv.stats))             │ ║
// ║     // → "缓存命中：95.2%（共 12 次请求，省 ¥0.0023）"     │ ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

// ─── 类型导出 ───
export type {
  MessageRole,
  PrefixHash,
  CacheStats,
  CachedConversation,
  CacheStreamCallbacks,
  CacheUsagePayload,
} from './cacheTypes.js'

// ─── 常量 + 工具函数导出 ───
export { CACHE_CONFIG, createEmptyCacheStats } from './cacheTypes.js'

// ─── 前缀指纹 ───
export {
  computePrefixHash,
  verifyPrefixStable,
  describeHashChange,
} from './prefixHash.js'

// ─── 只追加日志 ───
export { AppendOnlyLog } from './appendLog.js'

// ─── 缓存统计 ───
export {
  updateStatsWithUsage,
  formatStatsReport,
} from './cacheStats.js'

// ─── 主 API（创建会话、追加消息、流式对话、序列化）───
export {
  createCachedConversation,
  appendUserMessage,
  appendToolResult,
  chatStreamCached,
  getConversationStats,
  serializeConversation,
  restoreConversation,
} from './cacheClient.js'
