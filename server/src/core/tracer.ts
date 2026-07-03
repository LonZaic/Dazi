// ============================================================
// tracer.ts — 全链路追踪器（Agent 的飞机黑匣子）
// 文件路径：server/src/core/tracer.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这文件是 Agent 的"飞机黑匣子"——把 Agent 执行的每一步、     ║
// ║  每次调 LLM、每次出错都按时间顺序全记下来。出 bug 时回放，   ║
// ║  老板要成本报表时导出，前端要"AI 正在思考"时读它。           ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王发一句话，追踪器记了啥 ▼▼▼
//
//   小王在聊天框发"我最近开始跑步了"
//        │
//        ▼
//   routes/chat.ts 调 profileAgent.run()
//        │
//        ▼
//   ① profileAgent.run() 开头：
//      startSpan('profile-agent', { userId: '小王' })
//      → 造一个新 span，currentSpan = { id, name, steps:[], startedAt: now }
//        │
//        ▼
//   ② profileAgent.extractViaLLM()：
//      const result = await trace('llm_call',
//        { model: 'v4-flash', prompt: '...' },
//        () => chatOnce(...))
//      → trace 内部：
//        - 记录开始时间
//        - 执行 chatOnce() 调 LLM
//        - 成功后 addStep('llm_call', { success:true, model, prompt })
//        - 回填 durationMs = 1200ms
//        - token 累计到 currentSpan.totalTokens
//        │
//        ▼
//   ③ profileAgent 写入 blackboard：
//      addStep('extract', { patch: { interests:['跑步'] } })
//      → 加一步"抽取"记录，data 里存了这次抽出的画像
//        │
//        ▼
//   ④ profileAgent.run() 结尾：
//      endSpan({ confidence: 0.42 })
//      → 标记 endedAt，把 span 推入 spanHistory
//      → currentSpan = null
//        │
//        ▼
//   ⑤ 路由拿摘要：
//      getTraceSummary() → { totalSpans:1, totalSteps:2, totalTokens:920, ... }
//      → 存到 conversations.meta_json，前端可看
//
// ════════════════════════════════════════════════════════════
//  【数据流】
// ════════════════════════════════════════════════════════════
//
//   ┌─────────────────────────────────────────────────────┐
//   │  spanHistory（全局数组，存所有完成的 span）           │
//   │  ┌──────────────────────────────────────────────┐   │
//   │  │ TraceSpan {                                  │   │
//   │  │   id: 'span-1234567-ab12'                    │   │
//   │  │   name: 'profile-agent'                      │   │
//   │  │   startedAt: 1690000000000                   │   │
//   │  │   endedAt:   1690000001200  ← 1.2 秒         │   │
//   │  │   totalTokens: 920                           │   │
//   │  │   metadata: { userId: '小王' }                │   │
//   │  │   steps: [                                  │   │
//   │  │     { type:'llm_call', tokenCount:920, durationMs:1200 },   │
//   │  │     { type:'extract', data:{patch:{...}} }   │   │
//   │  │   ]                                         │   │
//   │  │ }                                           │   │
//   │  └──────────────────────────────────────────────┘   │
//   └─────────────────────────────────────────────────────┘
//
// ════════════════════════════════════════════════════════════
//  【为什么需要"飞机黑匣子"？】
// ════════════════════════════════════════════════════════════
//   1. 调试：用户说"AI 没回我" → 看 spanHistory 里哪步出错
//   2. 成本：老板问"花了多少钱" → getTraceSummary().totalTokens
//   3. 性能：发现某 span 耗时 30 秒 → 优化
//   4. 透明：前端显示"AI 思考了 1.2s，调了 1 次 LLM"
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - interface 类型联合：'llm_call' | 'recall' | ...（限定取值）
//   - 可选属性：endedAt?: number（带 ? 表示可省略）
//   - 泛型 <T>：trace<T> 让返回值类型跟传入函数一致
//   - 可选链 ?.：currentSpan?.steps（currentSpan 是 null 不报错）
//   - Math.random().toString(36)：转 36 进制字符串做 ID
// ============================================================

// ════════════════════════════════════════════════════════════
//  【类型 1】TraceStep — 一步记录（监控录像里的一帧）
// ════════════════════════════════════════════════════════════
// 文件路径：server/src/core/tracer.ts
export interface TraceStep {
  id: string                    // 步骤 ID（唯一标识）
                                //   格式：'step-1690000000000-ab12'
                                //   场景：debug 时按 ID 找具体步骤
                                //
  type: 'llm_call'              // 调了 LLM（最关键，烧钱）
      | 'tool_call'             // 调了工具（如向量检索）
      | 'recall'                // 向量召回（从 DB 找相似用户）
      | 'rank'                  // 排序打分（匹配候选排序）
      | 'extract'               // 抽取（画像 patch 提取）
      | 'info'                  // 一般信息（如"画像置信度 0.42"）
                                //   type 是"字面量联合类型"：
                                //   只能取这几个字符串之一，TS 会校验
                                //
  timestamp: number             // 发生时间（毫秒时间戳）
                                //   场景：Date.now() → 1690000000000
                                //   用于按时间排序和耗时统计
                                //
  durationMs: number            // 耗时（毫秒）
                                //   addStep 时填 0
                                //   trace() 异步操作结束后回填实际耗时
                                //   场景：LLM 调用 1200ms → durationMs: 1200
                                //
  data: Record<string, unknown> // 这一步的数据（结构随 type 变）
                                //   Record<string, unknown> = { [key: string]: 任意值 }
                                //   场景：
                                //     llm_call → { model:'v4-flash', prompt:'...', success:true }
                                //     extract → { patch: { interests:['跑步'] } }
                                //     recall → { hits: [...], count: 10 }
                                //
  tokenCount?: number           // 花了多少 token（? 可选）
                                //   只有 llm_call 步骤会填
                                //   其他步骤（如 extract）没 token 消耗 → undefined
}

// ════════════════════════════════════════════════════════════
//  【类型 2】TraceSpan — 一次完整的 Agent 执行（一条时间线）
// ════════════════════════════════════════════════════════════
// 文件路径：server/src/core/tracer.ts
export interface TraceSpan {
  id: string                        // span ID
                                    //   格式：'span-1690000000000-ab12'
                                    //
  name: string                      // span 名字
                                    //   场景：'profile-agent' / 'match-agent' / 'icebreaker'
                                    //   用于区分是谁的执行
                                    //
  steps: TraceStep[]                // 所有步骤的列表（按时间顺序）
                                    //   场景：[llm_call, extract, info] 3 步
                                    //
  startedAt: number                 // 开始时间（毫秒）
                                    //   场景：startSpan 调用瞬间记下
                                    //
  endedAt?: number                  // 结束时间（? 表示进行中时是 undefined）
                                    //   场景：endSpan 调用时记下
                                    //   耗时 = endedAt - startedAt
                                    //
  totalTokens: number               // 这个 span 累计花了多少 token
                                    //   场景：3 步 llm_call 各 300 → totalTokens = 900
                                    //   addStep 时如果带 tokenCount 会累加到这里
                                    //
  metadata: Record<string, unknown> // 元数据
                                    //   场景：{ userId: '小王', mode: 'llm', confidence: 0.42 }
                                    //   startSpan 传入 + endSpan 可追加
}

// ════════════════════════════════════════════════════════════
//  【全局状态】当前正在执行的 span
// ════════════════════════════════════════════════════════════
//   为什么用全局变量？
//   - addStep/trace 这些函数不用每次传 span 参数
//   - 同一时间只有一个 Agent 在执行（单线程 Node.js）
//   - 简化调用方代码
let currentSpan: TraceSpan | null = null  // null = 没在执行任何 Agent

// 【全局状态】所有已完成的 span 历史
const spanHistory: TraceSpan[] = []  // 数组，按完成顺序存

// ════════════════════════════════════════════════════════════
//  【函数 1】startSpan — 开始追踪一次 Agent 执行
// ════════════════════════════════════════════════════════════
//   调用方：BaseAgent.run() 开头
//   场景：profileAgent.run() → startSpan('profile-agent', { userId:'小王' })
//
//   参数：
//     name: Agent 名字（如 'profile-agent'）
//     metadata: 元数据（如 userId、mode）
//   返回值：新建的 span
// 文件路径：server/src/core/tracer.ts → startSpan()
export function startSpan(name: string, metadata: Record<string, unknown> = {}): TraceSpan {
  const span: TraceSpan = {
    // ID 生成：时间戳 + 6 位随机字符，保证唯一
    //   Math.random() → 0.123456...
    //   .toString(36) → '0.4fxxx'（36 进制：0-9 + a-z）
    //   .slice(2, 6) → '4fxx'（去掉 '0.' 取 4 位）
    //   为什么不只用 Date.now()？同一毫秒多次调用会冲突，加随机字符防重复
    id: `span-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,                        // Agent 名字
    steps: [],                   // 空步骤列表（后面 addStep 往里塞）
    startedAt: Date.now(),       // 开始时间 = 现在
    totalTokens: 0,              // token 从 0 开始累加
    metadata,                    // 元数据
  }
  currentSpan = span  // 设为当前活动的 span
  return span
}

// ════════════════════════════════════════════════════════════
//  【函数 2】endSpan — 结束追踪
// ════════════════════════════════════════════════════════════
//   调用方：BaseAgent.run() 结尾
//   场景：profileAgent 跑完 → endSpan({ confidence: 0.42 })
//        → 标记 endedAt，推入 spanHistory，currentSpan = null
//
//   参数：metadata（可选）→ 追加到 span.metadata
//   返回值：刚结束的 span（拷贝），或 null（没开始的 span）
// 文件路径：server/src/core/tracer.ts → endSpan()
export function endSpan(metadata?: Record<string, unknown>): TraceSpan | null {
  if (!currentSpan) return null  // 没 span 在执行，直接返回（防御性）
  currentSpan.endedAt = Date.now()  // 记下结束时间
  if (metadata) {
    // Object.assign(target, source)：把 source 的属性合并到 target
    //   场景：currentSpan.metadata = { userId:'小王' }
    //        metadata = { confidence: 0.42 }
    //        → 合并后 { userId:'小王', confidence: 0.42 }
    Object.assign(currentSpan.metadata, metadata)
  }
  spanHistory.push(currentSpan)     // 存进历史
  // 浅拷贝一份返回（用展开运算符 ...）
  //   为什么拷贝？防止调用方修改影响 spanHistory 里的原始数据
  const span = { ...currentSpan }
  currentSpan = null  // 清空当前 span
  return span
}

// ════════════════════════════════════════════════════════════
//  【函数 3】addStep — 在当前 span 里加一步记录
// ════════════════════════════════════════════════════════════
//   调用方：profileAgent 在调 LLM 后、写 blackboard 后等
//   场景：profileAgent.extractViaLLM() 后调
//        addStep('extract', { patch: { interests:['跑步'] } })
//
//   参数：
//     type: 步骤类型（'llm_call' | 'extract' | ...）
//     data: 这一步的数据
//     tokenCount: 可选，token 数（只有 llm_call 类步骤会传）
//   返回值：新建的 step
// 文件路径：server/src/core/tracer.ts → addStep()
export function addStep(
  type: TraceStep['type'],              // TraceStep['type'] 取 TraceStep 接口里的 type 字段类型
  data: Record<string, unknown>,
  tokenCount?: number,
): TraceStep {
  const step: TraceStep = {
    id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    timestamp: Date.now(),
    durationMs: 0,  // 初始耗时为 0（trace() 异步包装器会回填）
    data,
    tokenCount,
  }
  if (currentSpan) {
    currentSpan.steps.push(step)  // 把 step 加到当前 span 的步骤列表
    if (tokenCount) currentSpan.totalTokens += tokenCount  // 累计 token
    //   if (tokenCount) → 防止 undefined 和 0 都加进去
    //   （tokenCount 可能是 undefined，加 undefined 会变 NaN）
  }
  return step
}

// ════════════════════════════════════════════════════════════
//  【函数 4】trace — 追踪异步操作的耗时（高阶函数 + 泛型）
// ════════════════════════════════════════════════════════════
//   调用方：BaseAgent 调 LLM 时
//   场景：
//     const result = await trace('llm_call',
//       { model: 'v4-flash', prompt: '...' },
//       () => chatOnce(prompt))
//
//   它干 3 件事：
//   1. 记录开始时间
//   2. 执行 fn()
//   3. 成功 → addStep + 回填 durationMs；失败 → addStep 记录错误后抛出
//
//   泛型 <T>：让返回类型和 fn 的返回类型一致
//     fn: () => Promise<T> → 返回 Promise<T>
//     这样调用方拿到的是 chatOnce 的精确返回类型，不丢类型信息
// 文件路径：server/src/core/tracer.ts → trace()
export async function trace<T>(
  type: TraceStep['type'],
  data: Record<string, unknown>,
  fn: () => Promise<T>,  // fn 是个异步函数
): Promise<T> {
  const start = Date.now()  // 开始时间
  try {
    const result = await fn()  // 执行异步操作
    // ...data → 展开原 data
    //   场景：data = { model:'v4-flash' } → 展开成 { model:'v4-flash', success:true }
    addStep(type, { ...data, success: true })
    // 拿到刚加的最后一步，回填 durationMs
    //   currentSpan?.steps[...] → 可选链：currentSpan 是 null 就返回 undefined，不报错
    //   currentSpan.steps.length - 1 → 最后一个元素的下标
    const last = currentSpan?.steps[currentSpan.steps.length - 1]
    if (last) last.durationMs = Date.now() - start  // 回填耗时
    return result
  } catch (e) {
    // 失败也记录一步，方便看哪步出错
    //   (e as Error).message → 把 e 断言成 Error 类型取 message
    //   TS 默认 catch 的 e 是 unknown，要断言才能用 .message
    addStep(type, { ...data, success: false, error: (e as Error).message })
    throw e  // 重新抛出，让上层（BaseAgent）处理
  }
}

// ════════════════════════════════════════════════════════════
//  【函数 5】getCurrentSpan — 看当前活动的 span
// ════════════════════════════════════════════════════════════
//   场景：调试时想知道"现在哪个 Agent 在跑"
// 文件路径：server/src/core/tracer.ts → getCurrentSpan()
export function getCurrentSpan(): TraceSpan | null {
  return currentSpan
}

// ════════════════════════════════════════════════════════════
//  【函数 6】getSpanHistory — 看所有历史 span
// ════════════════════════════════════════════════════════════
//   场景：路由结束时调，把所有 span 序列化存到 conversations.meta_json
// 文件路径：server/src/core/tracer.ts → getSpanHistory()
export function getSpanHistory(): TraceSpan[] {
  return spanHistory
}

// ════════════════════════════════════════════════════════════
//  【函数 7】getTraceSummary — 生成追踪摘要
// ════════════════════════════════════════════════════════════
//   调用方：routes/chat.ts 把摘要存到 conversations.meta_json
//   场景：用户看历史消息时，每条 AI 消息显示"思考 1.2s，920 token"
//
//   返回值：聚合统计（总 span 数、总步骤数、总 token、总耗时、错误数）
// 文件路径：server/src/core/tracer.ts → getTraceSummary()
export function getTraceSummary() {
  let totalSteps = 0       // 步骤总数
  let totalTokens = 0      // token 总数
  let totalDurationMs = 0  // 总耗时（毫秒）
  let errors = 0           // 错误次数

  for (const span of spanHistory) {
    totalSteps += span.steps.length     // 累加每个 span 的步骤数
    totalTokens += span.totalTokens     // 累加 token
    if (span.endedAt) totalDurationMs += span.endedAt - span.startedAt  // 累加耗时
    //   if (span.endedAt)：没结束的 span 不算耗时（防 undefined - number = NaN）
    for (const s of span.steps) {
      if (s.data.error) errors++  // 数错误次数
      //   s.data.error 有值 → 这步出错了
    }
  }

  return {
    totalSpans: spanHistory.length,  // 执行了几个 Agent
    totalSteps,                       // 总共几步
    totalTokens,                      // 总共花了多少 token
    totalDurationMs,                  // 总共耗时多少毫秒
    errors,                           // 总共错了几次
  }
}

// ════════════════════════════════════════════════════════════
//  【函数 8】clearTraces — 清空所有追踪记录
// ════════════════════════════════════════════════════════════
//   调用方：每次新对话开始时（routes/chat.ts 入口）
//   场景：用户小王发新消息 → clearTraces() → 上次的 span 清掉
//        防止 spanHistory 无限增长爆内存
// 文件路径：server/src/core/tracer.ts → clearTraces()
export function clearTraces(): void {
  spanHistory.length = 0     // 数组清空（length = 0 删所有元素）
  currentSpan = null         // 当前 span 也清掉
}
