// ============================================================
// index.ts — tools 模块统一出口
// ============================================================

// 工具定义 + 执行
export { readFileDef, executeReadFile, cacheFile, clearUserCache, isTextFile } from './readFile.js'

// 注册中心 + function calling 调度
export {
  ALL_TOOLS,
  dispatchToolCall,
  handleFunctionCalling,
} from './registry.js'
export type { ToolDef, ToolCallResult } from './registry.js'
