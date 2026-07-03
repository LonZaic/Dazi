// ============================================================
// traceLogger.ts — 全链路运行日志（函数调用 + 数据流 + 时间线）
// 文件路径：server/src/services/traceLogger.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  目的：把每次测试的全过程记下来，方便理解项目 + 诊断问题。    ║
// ║                                                            ║
// ║  能力：                                                     ║
// ║   1. 函数调用日志（谁调谁、参数、返回值、耗时）              ║
// ║   2. 数据流日志（用户消息→画像→匹配→破冰 全链路）           ║
// ║   3. token 消费日志（每次 LLM 调用的 prompt/completion/cost）║
// ║   4. 事件日志（状态机转移、Redis 读写、缓存命中）            ║
// ║                                                            ║
// ║  双写：                                                     ║
// ║   - 内存数组（提供 API 查询，用于 HTML 报告）               ║
// ║   - 文件 logs/trace-YYYYMMDD-HHmmss.ndjson（每行一条 JSON） ║
// ║                                                            ║
// ║  使用方式：                                                 ║
// ║   import { trace } from '../services/traceLogger.js'        ║
// ║   trace.fn('matchAgent.run', () => agent.run(...))         ║
// ║   trace.event('match_done', { userId, candidates })        ║
// ║   trace.token({ prompt: 123, completion: 456, model })     ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

import { mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ════════════════════════════════════════════════════════════
//  【类型】TraceEntry — 一条日志记录
// ════════════════════════════════════════════════════════════
export type TraceLevel = 'debug' | 'info' | 'warn' | 'error'
export type TraceKind  = 'fn' | 'event' | 'token' | 'data' | 'cache' | 'state'

export interface TraceEntry {
  /** 时间戳（ms） */
  ts: number
  /** 可读时间 */
  time: string
  /** 日志类别 */
  kind: TraceKind
  /** 日志级别 */
  level: TraceLevel
  /** 事件/函数名 */
  name: string
  /** 关联用户 ID（可选，方便按用户过滤） */
  userId?: string
  /** 关联 traceId（可选，方便按请求追踪） */
  traceId?: string
  /** 耗时（ms，仅 fn 类型） */
  durationMs?: number
  /** 数据载荷 */
  payload?: any
  /** 返回值（仅 fn 类型） */
  result?: any
  /** 错误信息（若有） */
  error?: string
}

// ════════════════════════════════════════════════════════════
//  【配置】日志目录
// ════════════════════════════════════════════════════════════
const __dirname = dirname(fileURLToPath(import.meta.url))
// logs 目录在项目根 e:\DZ\server\logs\
const LOG_DIR = join(__dirname, '..', '..', 'logs')
try {
  mkdirSync(LOG_DIR, { recursive: true })
} catch {
  // 目录已存在或无权限，忽略
}

// 当前日志文件（按启动时间命名）
const LOG_FILE = join(LOG_DIR, `trace-${formatFileTimestamp(Date.now())}.ndjson`)

// ════════════════════════════════════════════════════════════
//  【内存缓冲】用于 HTML 报告查询
// ════════════════════════════════════════════════════════════
//   最多保留 5000 条，超出从头删
const MAX_ENTRIES = 5000
const entries: TraceEntry[] = []

// ════════════════════════════════════════════════════════════
//  【内部工具】写一条日志（内存 + 文件双写）
// ════════════════════════════════════════════════════════════
function write(entry: TraceEntry): void {
  // ① 内存
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
  // ② 文件（NDJSON：每行一条 JSON，方便 grep/jq 分析）
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // 文件写失败不阻塞主流程
  }
  // ③ 控制台（彩色简短输出）
  const prefix = colorize(entry.kind, entry.level)
  const dur = entry.durationMs != null ? ` ${entry.durationMs}ms` : ''
  const tail = entry.error ? ` ❌ ${entry.error}` : ''
  // eslint-disable-next-line no-console
  console.log(`${entry.time} ${prefix} ${entry.name}${dur}${tail}`)
}

// ════════════════════════════════════════════════════════════
//  【内部工具】时间格式化
// ════════════════════════════════════════════════════════════
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function formatFileTimestamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// ════════════════════════════════════════════════════════════
//  【内部工具】彩色输出（按 kind 着色）
// ════════════════════════════════════════════════════════════
function colorize(kind: TraceKind, level: TraceLevel): string {
  // ANSI 颜色
  const colors: Record<TraceKind, string> = {
    fn:    '\x1b[36m',  // cyan
    event: '\x1b[35m',  // magenta
    token: '\x1b[33m',  // yellow
    data:  '\x1b[32m',  // green
    cache: '\x1b[34m',  // blue
    state: '\x1b[90m',  // gray
  }
  const levelColors: Record<TraceLevel, string> = {
    debug: '\x1b[90m',
    info:  '\x1b[1m',
    warn:  '\x1b[33m',
    error: '\x1b[31m',
  }
  const reset = '\x1b[0m'
  const tag = `[${kind.toUpperCase()}]`.padEnd(8)
  return `${colors[kind]}${tag}${reset}${levelColors[level]}`
}

// ════════════════════════════════════════════════════════════
//  【对外 API】trace 对象
// ════════════════════════════════════════════════════════════
export const trace = {
  /**
   * trace.fn() — 包裹一个函数调用，自动记录入参/返回/耗时
   * @param name    函数名（如 'matchAgent.run'）
   * @param fn      被包裹的函数
   * @param opts    额外选项（userId / payload）
   * @returns fn 的返回值
   */
  async fn<T>(
    name: string,
    fn: () => Promise<T> | T,
    opts?: { userId?: string; traceId?: string; payload?: any },
  ): Promise<T> {
    const start = Date.now()
    try {
      const result = await fn()
      const duration = Date.now() - start
      write({
        ts: start,
        time: formatTime(start),
        kind: 'fn',
        level: 'info',
        name,
        userId: opts?.userId,
        traceId: opts?.traceId,
        durationMs: duration,
        payload: opts?.payload,
        result: safeSample(result),
      })
      return result
    } catch (err: any) {
      const duration = Date.now() - start
      write({
        ts: start,
        time: formatTime(start),
        kind: 'fn',
        level: 'error',
        name,
        userId: opts?.userId,
        traceId: opts?.traceId,
        durationMs: duration,
        payload: opts?.payload,
        error: err?.message || String(err),
      })
      throw err
    }
  },

  /**
   * trace.event() — 记录一个事件（状态机转移、用户行为等）
   */
  event(name: string, payload?: any, opts?: { userId?: string; level?: TraceLevel }): void {
    const ts = Date.now()
    write({
      ts,
      time: formatTime(ts),
      kind: 'event',
      level: opts?.level || 'info',
      name,
      userId: opts?.userId,
      payload,
    })
  },

  /**
   * trace.token() — 记录一次 LLM 调用的 token 消费
   * @param info  token 使用详情
   */
  token(info: {
    model: string
    prompt: number
    completion: number
    cacheHit?: number       // 缓存命中 token（DeepSeek prefix cache）
    cacheMiss?: number      // 缓存未命中 token
    hitRate?: number        // 缓存命中率（0~1）
    costYuan?: number       // 真实花费（人民币元，hit/miss 分别计价）
    userId?: string
    scenario?: string       // 场景（如 'chat' / 'extract' / 'summary'）
  }): void {
    const ts = Date.now()
    const total = info.prompt + info.completion
    write({
      ts,
      time: formatTime(ts),
      kind: 'token',
      level: 'info',
      name: `llm.${info.scenario || 'call'}`,
      userId: info.userId,
      payload: {
        model: info.model,
        promptTokens: info.prompt,
        completionTokens: info.completion,
        totalTokens: total,
        cacheHitTokens: info.cacheHit || 0,
        cacheMissTokens: info.cacheMiss || 0,
        hitRate: info.hitRate || 0,
        costYuan: info.costYuan || 0,
      },
    })
  },

  /**
   * trace.data() — 记录数据流（画像更新、匹配结果等）
   */
  data(name: string, data: any, opts?: { userId?: string }): void {
    const ts = Date.now()
    write({
      ts,
      time: formatTime(ts),
      kind: 'data',
      level: 'info',
      name,
      userId: opts?.userId,
      payload: data,
    })
  },

  /**
   * trace.cache() — 记录缓存命中/未命中
   */
  cache(name: string, hit: boolean, payload?: any): void {
    const ts = Date.now()
    write({
      ts,
      time: formatTime(ts),
      kind: 'cache',
      level: hit ? 'info' : 'warn',
      name: `${name}.${hit ? 'hit' : 'miss'}`,
      payload,
    })
  },

  /**
   * trace.state() — 记录状态变化
   */
  state(name: string, from: string, to: string, payload?: any): void {
    const ts = Date.now()
    write({
      ts,
      time: formatTime(ts),
      kind: 'state',
      level: 'info',
      name: `${name}: ${from} → ${to}`,
      payload,
    })
  },

  /**
   * getEntries() — 读取所有日志（用于 HTML 报告）
   * @param filter 可选过滤条件
   */
  getEntries(filter?: {
    kind?: TraceKind
    userId?: string
    since?: number
  }): TraceEntry[] {
    return entries.filter(e => {
      if (filter?.kind && e.kind !== filter.kind) return false
      if (filter?.userId && e.userId !== filter.userId) return false
      if (filter?.since && e.ts < filter.since) return false
      return true
    })
  },

  /**
   * getLogFile() — 返回当前日志文件路径
   */
  getLogFile(): string {
    return LOG_FILE
  },

  /**
   * clear() — 清空内存日志（不影响文件）
   */
  clear(): void {
    entries.length = 0
  },
}

// ════════════════════════════════════════════════════════════
//  【内部工具】safeSample — 安全采样返回值（避免循环引用 / 过大）
// ════════════════════════════════════════════════════════════
function safeSample(v: any): any {
  if (v == null) return v
  // 字符串/数字/布尔直接返回
  if (typeof v !== 'object') return v
  try {
    // 数组只取前 3 项
    if (Array.isArray(v)) {
      return {
        __type: 'array',
        length: v.length,
        sample: v.slice(0, 3).map(safeSample),
      }
    }
    // 对象只保留前 10 个 key
    const keys = Object.keys(v).slice(0, 10)
    const out: any = {}
    for (const k of keys) {
      const val = v[k]
      if (typeof val === 'string') {
        out[k] = val.length > 200 ? val.slice(0, 200) + '...' : val
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        out[k] = val
      } else if (val == null) {
        out[k] = val
      } else {
        out[k] = `[${typeof val}]`
      }
    }
    return out
  } catch {
    return '[unserializable]'
  }
}
