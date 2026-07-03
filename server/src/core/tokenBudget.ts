// ============================================================
// tokenBudget.ts — Token 预算追踪（Agent 的钱包，防烧钱）
// 文件路径：server/src/core/tokenBudget.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这文件是 Agent 的"钱包"——记每次调 LLM 花了多少 token。   ║
// ║  LLM 不便宜（1 万 token 约 ¥0.1-1），不能让 Agent 无限烧。 ║
// ║                                                          ║
// ║  阈值：                                                    ║
// ║   - 75%（shouldNudge）：软提醒"悠着点，聚焦核心任务"        ║
// ║   - 90%（shouldForceStop）：硬停"别调 LLM 了，用现有结果"   ║
// ║   - 收益递减（diminishing）：最近 3 轮产出 < 200 token      ║
// ║     → "花同样的钱，产出越来越少，趁早结束"                  ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王狂聊天的预算消耗 ▼▼▼
//
//   总预算：20 万 token（createBudgetTracker 默认值）
//
//   第 1 轮：小王发"我喜欢跑步"
//     - 输入 prompt：1500 字符 ≈ 600 token
//     - 输出画像 JSON：800 字符 ≈ 320 token
//     - 累计：920 token（0.46%）
//     - getStatus() → { pct: 0.005, shouldNudge: false, shouldForceStop: false }
//
//   第 50 轮：小王已经聊了很多
//     - 累计：15 万 token（75%）
//     - getStatus() → { shouldNudge: true }
//     - getNudgeMessage() → "[系统] 预算 75%。聚焦核心字段抽取。"
//     - BaseAgent 看到 → prompt 改成"只抽取关键字段，跳过次要信息"
//
//   第 70 轮：小王还在聊
//     - 累计：18 万 token（90%）
//     - getStatus() → { shouldForceStop: true }
//     - getNudgeMessage() → "[系统] Token 预算耗尽 (90%)。停止调用 LLM..."
//     - BaseAgent 看到 → 立即停 LLM，用规则模式兜底
//
//   收益递减检测：
//     第 60、61、62 轮 LLM 输出都很短（< 200 token）
//     且累计已用 60%
//     → diminishing: true
//     → "花同样的钱产出越来越少，趁早结束本轮抽取"
//
// ════════════════════════════════════════════════════════════
//  【数据流】
// ════════════════════════════════════════════════════════════
//
//   ProfileAgent.run()
//        │
//        ▼
//   ① 调 LLM 前：budget.recordInput(估算的输入 token)
//        │
//        ▼
//   ② LLM 返回后：budget.recordApiUsage(实际输入, 实际输出)
//      （用 API 返回的精确值覆盖估算值）
//        │
//        ▼
//   ③ 每轮结束：const status = budget.getStatus()
//        │
//        ▼
//   ④ 检查预算：
//      if (status.shouldForceStop) → 停止 Agent
//      if (status.shouldNudge) → 修改 prompt 聚焦核心
//      if (status.diminishing) → 尽快结束
//
// ════════════════════════════════════════════════════════════
//  【为什么是 20 万 token？】
// ════════════════════════════════════════════════════════════
//   - 一个用户聊 50-100 轮对话，每轮约 1000-3000 token
//   - 20 万 token 够跑 60-200 轮，覆盖绝大多数用户场景
//   - 成本：约 ¥2-20/用户（看模型定价）
//   - 生产环境可调（config 里改）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - interface → 定义对象结构
//   - 闭包 → 返回的对象里的函数共享 inputTokens 等变量
//   - 200_000 → 数字分隔符（ES2021），等同于 200000，更易读
//   - Math.ceil / Math.round / Math.max → 数学函数
//   - every() → 数组方法，检查是否每个元素都满足条件
// ============================================================

// ════════════════════════════════════════════════════════════
//  【类型 1】BudgetStatus — 当前预算状态快照
// ════════════════════════════════════════════════════════════
//   场景：BaseAgent 每轮调 getStatus() 拿这个对象，决策后续动作
// 文件路径：server/src/core/tokenBudget.ts
export interface BudgetStatus {
  used: number              // 已用 token 数（输入 + 输出累计）
                            //   场景：聊了 50 轮 → used = 150000
                            //
  remaining: number         // 剩余 token 数（不能为负）
                            //   场景：remaining = 200000 - 150000 = 50000
                            //
  pct: number               // 已用百分比（0-1，如 0.75 = 75%）
                            //   场景：0.75 → 触发 shouldNudge
                            //
  shouldNudge: boolean      // 是否该提示省点了（≥75% 且 <90%）
                            //   true 时 BaseAgent 修改 prompt 聚焦核心字段
                            //
  shouldForceStop: boolean  // 是否该强制停了（≥90%）
                            //   true 时 BaseAgent 立即停 LLM，降级规则模式
                            //
  diminishing: boolean      // 最近产出是否在递减
                            //   true 条件：最近 3 轮每轮输出都 < 200 token 且 pct > 50%
                            //   场景：LLM 返回内容越来越短 → 趁早结束
                            //
  totalBudget: number       // 总预算（默认 20 万）
                            //   用于 UI 显示"已用 15 万 / 20 万"
}

// ════════════════════════════════════════════════════════════
//  【类型 2】BudgetTracker — 预算追踪器的接口
// ════════════════════════════════════════════════════════════
// 文件路径：server/src/core/tokenBudget.ts
export interface BudgetTracker {
  // 记录输入 token（调 LLM 前估算）
  //   场景：ProfileAgent 准备调 LLM，prompt 有 1500 字符
  //        recordInput(estimateTextTokens(prompt))  // 估算 600 token
  recordInput(tokens: number): void

  // 记录输出 token（LLM 返回后估算）
  //   场景：LLM 返回 800 字符的画像 JSON
  //        recordOutput(estimateTextTokens(response))  // 估算 320 token
  recordOutput(tokens: number): void

  // 记录一次 API 调用的总用量（用 API 返回的精确值）
  //   场景：LLM API 返回 usage: { input: 612, output: 318 }
  //        recordApiUsage(612, 318)  // 用精确值覆盖估算值
  recordApiUsage(input: number, output: number): void

  // 看当前预算状态
  //   场景：BaseAgent 每轮调一次，看该不该停
  getStatus(): BudgetStatus

  // 获取提醒信息（null = 不用提醒）
  //   场景：BaseAgent 把这个消息塞进 prompt 给 LLM 看
  //        LLM 看到"[系统] 预算 75%"会自动聚焦核心任务
  getNudgeMessage(): string | null

  // 重置预算（从头开始记）
  //   场景：用户开始新会话时调（虽然现在没调，预留接口）
  reset(): void
}

// ════════════════════════════════════════════════════════════
//  【工具函数】estimateTextTokens — 粗估文本 token 数
// ════════════════════════════════════════════════════════════
//   为什么需要估算？
//   - 调 LLM 前不知道精确 token 数（API 还没返回）
//   - 但要预先扣预算（防超额）
//   - 所以用文本长度估算
//
//   估算公式：text.length / 2.5
//   - 中文：约 2 字符 = 1 token（"我喜欢跑步" 5 字符 ≈ 2-3 token）
//   - 英文：约 4 字符 = 1 token（"hello world" 11 字符 ≈ 3 token）
//   - 中英混合：取中间值 2.5 字符 = 1 token（够用）
//
//   调用方：BaseAgent 在调 LLM 前估算
//            routes/chat.ts 估算历史消息 token
// 文件路径：server/src/core/tokenBudget.ts → estimateTextTokens()
export function estimateTextTokens(text: string): number {
  if (!text) return 0  // 空文本 0 token
  // Math.ceil：向上取整（1.1 → 2，0.1 → 1）
  // 向上取整原因：宁可高估不可低估（防超额）
  return Math.ceil(text.length / 2.5)
}

// ════════════════════════════════════════════════════════════
//  【工厂函数】createBudgetTracker — 造一个新的预算追踪器
// ════════════════════════════════════════════════════════════
//   谁调用：orchestrator.ts 的 getSession() 给新用户发一本
//   参数：totalBudget 总预算，默认 20 万 token
//     200_000 是数字分隔符写法（ES2021），等同于 200000
//     下划线让大数字更易读（200_000 vs 200000）
// 文件路径：server/src/core/tokenBudget.ts → createBudgetTracker()
export function createBudgetTracker(totalBudget = 200_000): BudgetTracker {
  let inputTokens = 0        // 累计输入 token
                            //   场景：调 50 次 LLM，每次输入 600 → inputTokens = 30000
  let outputTokens = 0       // 累计输出 token
                            //   场景：调 50 次 LLM，每次输出 320 → outputTokens = 16000
  const roundOutputs: number[] = []  // 最近几轮的输出 token 数组
                                      //   场景：[320, 280, 150] → 最近 3 轮输出
                                      //   用于检测收益递减
  const NUDGE = 0.75   // 75% 软提醒阈值
  const FORCE = 0.90   // 90% 强制停止阈值

  // ──────────────────────────────────────────────────────
  // 【方法 1】recordInput — 记录输入 token
  // ──────────────────────────────────────────────────────
  //   调用方：BaseAgent 调 LLM 前调
  //   场景：prompt 估算 600 token → recordInput(600)
  function recordInput(tokens: number) {
    // Math.round：四舍五入（600.4 → 600，600.5 → 601）
    // Math.max(0, ...)：防负数（防御性编程，万一传错了）
    inputTokens += Math.max(0, Math.round(tokens))
  }

  // ──────────────────────────────────────────────────────
  // 【方法 2】recordOutput — 记录输出 token
  // ──────────────────────────────────────────────────────
  //   调用方：BaseAgent 调 LLM 后调
  //   场景：LLM 返回 800 字符 → 估算 320 token → recordOutput(320)
  function recordOutput(tokens: number) {
    const t = Math.max(0, Math.round(tokens))
    outputTokens += t
    roundOutputs.push(t)  // 记下这一轮的输出量
    // 只保留最近 5 轮（防止数组无限增长）
    // shift：删除数组第一个元素（最早的）
    if (roundOutputs.length > 5) roundOutputs.shift()
  }

  // ──────────────────────────────────────────────────────
  // 【方法 3】recordApiUsage — 用 API 返回的精确值覆盖估算值
  // ──────────────────────────────────────────────────────
  //   为什么覆盖？
  //   - 估算值不准（中英混合比例不同）
  //   - API 返回的 usage 字段是精确值
  //   - 用 Math.max 取较大值（防止估算偏低导致少扣预算）
  //
  //   场景：API 返回 { input: 612, output: 318 }
  //        之前估算 inputTokens=600 → 修正为 612
  function recordApiUsage(input: number, output: number) {
    inputTokens = Math.max(inputTokens, Math.round(input))
    outputTokens = Math.max(outputTokens, Math.round(output))
  }

  // ──────────────────────────────────────────────────────
  // 【方法 4】getStatus — 获取当前预算状态
  // ──────────────────────────────────────────────────────
  //   调用方：BaseAgent 每轮调一次
  //   返回值：BudgetStatus 对象，包含 used/pct/shouldNudge 等
  function getStatus(): BudgetStatus {
    const used = inputTokens + outputTokens           // 已用 = 输入 + 输出
    const remaining = Math.max(0, totalBudget - used) // 剩余（最小为 0，防负）
    const pct = totalBudget > 0 ? used / totalBudget : 0  // 百分比（0-1）
    // 三元运算符：totalBudget > 0 ? 算百分比 : 0
    //   防除以 0（万一 totalBudget 配错了）

    const shouldNudge = pct >= NUDGE && pct < FORCE  // ≥75% 且 <90% → 软提醒
    const shouldForceStop = pct >= FORCE              // ≥90% → 强制停

    // 检测收益递减
    // 触发条件：最近 3 轮每轮输出都 < 200 token，且已用 > 50%
    //   场景：LLM 返回越来越短，说明信息快抽干了
    let diminishing = false
    if (roundOutputs.length >= 3) {
      // every：数组方法，检查是否每个元素都满足条件
      //   [320, 150, 80].every(t => t < 200) → false（320 不小于）
      //   [150, 80, 50].every(t => t < 200) → true
      diminishing = roundOutputs.every(t => t < 200) && pct > 0.5
    }

    return {
      used,
      remaining,
      // Math.round(pct * 100) / 100：保留两位小数
      //   场景：pct = 0.75321 → Math.round(75.321) / 100 = 0.75
      pct: Math.round(pct * 100) / 100,
      shouldNudge,
      shouldForceStop,
      diminishing,
      totalBudget,
    }
  }

  // ──────────────────────────────────────────────────────
  // 【方法 5】getNudgeMessage — 获取提醒信息
  // ──────────────────────────────────────────────────────
  //   调用方：BaseAgent 把返回的字符串塞进 prompt 给 LLM 看
  //   返回值：null 表示不用提醒；字符串表示要提醒的内容
  //
  //   场景：
  //   - 预算 60% → 返回 null（不用提醒）
  //   - 预算 80% → 返回 "[系统] 预算 80%。聚焦核心字段抽取。"
  //   - 预算 80% + 收益递减 → 返回 "[系统] 预算 80%，产出递减..."
  //   - 预算 95% → 返回 "[系统] Token 预算耗尽 (95%)..."
  function getNudgeMessage(): string | null {
    const s = getStatus()
    if (s.shouldForceStop) {
      // 优先级最高：强制停止
      // Math.round(s.pct * 100)：0.95 → 95（百分比整数）
      return `[系统] Token 预算耗尽 (${Math.round(s.pct * 100)}%)。停止调用 LLM，直接用已有画像给出结果。`
    }
    if (s.shouldNudge && s.diminishing) {
      // 次优先级：软提醒 + 收益递减
      return `[系统] 预算 ${Math.round(s.pct * 100)}%，产出递减。尽快结束本轮抽取。`
    }
    if (s.shouldNudge) {
      // 普通软提醒
      return `[系统] 预算 ${Math.round(s.pct * 100)}%。聚焦核心字段抽取。`
    }
    return null  // 不用提醒
  }

  // ──────────────────────────────────────────────────────
  // 【方法 6】reset — 重置预算
  // ──────────────────────────────────────────────────────
  //   场景：测试用例每个 case 前调，清空状态
  //        （生产环境目前没调，预算跨会话累计）
  function reset() {
    inputTokens = 0
    outputTokens = 0
    roundOutputs.length = 0  // 数组清空
  }

  // 返回对象，暴露 6 个方法
  return { recordInput, recordOutput, recordApiUsage, getStatus, getNudgeMessage, reset }
}
