// ============================================================
// baseAgent.ts — Agent 基类（"工作手册"模板方法模式）
// 文件路径：server/src/agents/baseAgent.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这是三个 Agent（Profile/Match/IceBreaker）的"共同工作      ║
// ║  手册"。每个 Agent 入职（继承这个类）时，自动获得：           ║
// ║   - 计时（出问题能查耗时）                                   ║
// ║   - try/catch 兜底（出 bug 不挂掉）                          ║
// ║   - token 记账（防止超预算）                                 ║
// ║   - 踩坑本记录（防止 Agent 卡死循环）                        ║
// ║  子类只需要写一个 execute() 方法（"我具体干啥活"），其他全自动。║
// ║                                                            ║
// ║  这就像餐厅的"标准摆盘流程"：不管你做牛排还是沙拉，           ║
// ║  端上桌前必须检查温度（计时）、检查成本（记账）、             ║
// ║  万一糊了写检讨（出错记录）。                                ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：ProfileAgent 干活的全流程 ▼▼▼
//
//   小王发"我最近开始跑步了"
//        │
//        ▼
//   routes/chat.ts 调用：
//     const result = await profileAgent.run(
//       { userMessage: '我最近开始跑步了', history: [...] },
//       ctx   ← 工具箱：blackboard + budget + loopDetector
//     )
//        │
//        ▼
//   BaseAgent.run() 内部：
//   ① start = Date.now()                 // 计时开始
//   ② tokensBefore = budget.used         // 记账：执行前余额
//   ③ try { data = await this.execute(input, ctx) }   ← 调子类方法
//        │
//        ▼
//      ProfileAgent.execute()  ← 子类实现
//        - 拼 prompt
//        - 调 LLM
//        - 解析返回
//        - 写 blackboard
//        - 返回画像 patch
//        │
//        ▼
//   ④ 成功 → return { ok:true, data, tokensUsed, durationMs }
//      失败 → catch 里：
//        - loopDetector.recordError()  // 写踩坑本
//        - return { ok:false, error, tokensUsed, durationMs }
//        │
//        ▼
//   routes/chat.ts 拿到 result →
//     if (result.ok) { 用 result.data 更新画像 }
//     else { 给用户回"系统开小差了" }
//
// ════════════════════════════════════════════════════════════
//  【核心设计模式：模板方法（Template Method）】
// ════════════════════════════════════════════════════════════
//   run() 是模板（基类定的骨架，子类不能改），
//   execute() 是钩子（子类必须实现），
//   run() 调用 execute()，在前后加统一的计时/记账/兜底逻辑。
//
//   好处：
//   - 复用：3 个 Agent 共享一套计时/记账/兜底，不重复写
//   - 一致：所有 Agent 都按同样格式返回 AgentResult
//   - 可观测：统一记录 token 和耗时，方便统计
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - abstract class → 抽象类，不能直接 new，必须继承后实现
//   - abstract execute() → 抽象方法，子类必须实现
//   - <TInput, TOutput> → 泛型参数，子类决定输入输出的具体类型
//   - = unknown → 默认值，子类不填泛型时用 unknown
//   - protected → 只能在类内部和子类访问，外部调不了
//   - try/catch → JS 异常处理，try 里出错了走 catch
// ============================================================

// ────────────────────────────────────────────────────────────
// 【类型导入】只导类型，不导值
// ────────────────────────────────────────────────────────────
//   import type：只导入类型定义，编译后这行会被删掉（不增加运行时体积）
//   如果用普通 import，会引入运行时代码（多占内存）
import type { Blackboard } from '../core/blackboard.js'
import type { LoopDetector } from '../core/antiloop.js'
import type { BudgetTracker } from '../core/tokenBudget.js'
//   这个要导入值（不只是类型），因为要调 estimateTextTokens 函数
import { estimateTextTokens } from '../core/tokenBudget.js'
//   .js 后缀：TS 编译成 JS 后，import 路径要保持 .js（Node ESM 规范）

// ════════════════════════════════════════════════════════════
//  【类型 1】AgentContext — Agent 执行时的"工具箱"
// ════════════════════════════════════════════════════════════
//   每个 Agent 执行时都能拿到这些东西
//   场景：routes/chat.ts 调 profileAgent.run(input, ctx)
//        ctx 里塞了 blackboard、budget、loopDetector 等
// 文件路径：server/src/agents/baseAgent.ts
export interface AgentContext {
  userId: string           // 当前用户 ID
                            //   场景：'user-小王-001'
                            //   用于：日志/数据库查询/前端推送
                            //
  tenantId: string         // 租户 ID（多租户架构）
                            //   场景：'tenant-acme'
                            //   多租户：一套代码服务多个公司，数据隔离
                            //   这个项目可能就一个 tenant，但接口预留
                            //
  budget: BudgetTracker    // token 记账本
                            //   场景：调 LLM 前 budget.recordInput(600)
                            //        调 LLM 后 budget.recordApiUsage(612, 318)
                            //        BaseAgent.run 用 budget.used 算 token 消耗
                            //
  blackboard: Blackboard   // 黑板（Agent 间贴便条）
                            //   场景：ProfileAgent 写 latest_profile 便条
                            //        MatchAgent 读 latest_profile 便条
                            //
  loopDetector: LoopDetector  // 反循环器（踩坑本）
                            //   场景：ProfileAgent 连续 3 次调同样的 LLM
                            //        → loopDetector 触发警告 → BaseAgent 提前停
                            //
  profileConfidence?: number // 画像置信度（可选）
                            //   场景：MatchAgent 启动前看一眼这个
                            //        如果 < 0.65 → 提示 ProfileAgent 先多聊几句
                            //   ? 表示可以不传（可能是 undefined）
                            //
  state?: string           // 当前会话状态
                            //   场景：'CHATTING' / 'MATCHING' / 'MATCHED' / ...
                            //   来自 orchestrator 的 SessionState
}

// ════════════════════════════════════════════════════════════
//  【类型 2】AgentResult — Agent 干完活交的"工作汇报单"
// ════════════════════════════════════════════════════════════
//   <T = unknown> → 泛型默认值
//     子类传具体类型覆盖 T：
//       ProfileAgent → AgentResult<ProfilePatch>
//       MatchAgent   → AgentResult<MatchResult[]>
//       IceBreaker   → AgentResult<IceBreakerOutput>
// 文件路径：server/src/agents/baseAgent.ts
export interface AgentResult<T = unknown> {
  agentId: string     // Agent ID（谁干的活）
                      //   场景：'profile-agent' / 'match-agent' / 'icebreaker-agent'
                      //   用于：日志区分、UI 显示"ProfileAgent 思考中"
                      //
  ok: boolean         // 成功还是失败了
                      //   true → 用 data 字段
                      //   false → 用 error 字段
                      //
  data?: T            // 成功时的返回数据（? 可选，失败时没有）
                      //   场景：ProfileAgent 返回 { interests:['跑步'], ... }
                      //        MatchAgent 返回 [MatchResult, MatchResult, ...]
                      //
  error?: string      // 失败时的错误信息（? 可选，成功时没有）
                      //   场景：'LLM API 超时' / 'JSON 解析失败'
                      //
  tokensUsed: number  // 这次执行花了多少 token
                      //   场景：920（输入 600 + 输出 320）
                      //   BaseAgent.run 用 budget.used 前后相减算出
                      //   用于：成本统计、前端显示
                      //
  durationMs: number  // 这次执行花了多少毫秒
                      //   场景：1200（1.2 秒）
                      //   BaseAgent.run 用 Date.now() 前后相减算出
                      //   用于：性能监控、慢查询排查
}

// ════════════════════════════════════════════════════════════
//  【抽象类】BaseAgent — 三个 Agent 的"共同工作手册"
// ════════════════════════════════════════════════════════════
//   <TInput = unknown, TOutput = unknown>：两个泛型参数
//     TInput  = 输入类型（每个 Agent 不同）
//     TOutput = 输出类型（每个 Agent 不同）
//     = unknown：不传时的默认值（表示"未知类型"，比 any 安全）
//
//   抽象类（abstract class）特点：
//   - 不能直接 new BaseAgent()（必须继承后用子类）
//   - 可以有具体方法（run）和抽象方法（execute）
//   - 子类必须实现所有 abstract 成员
// 文件路径：server/src/agents/baseAgent.ts → BaseAgent
export abstract class BaseAgent<TInput = unknown, TOutput = unknown> {

  // ──────────────────────────────────────────────────────
  // 【抽象属性】子类必须定义自己的 ID 和描述
  // ──────────────────────────────────────────────────────
  //   abstract 表示"这个属性必须在子类里实现，基类只声明不赋值"
  //   场景：ProfileAgent 里：
  //     agentId = 'profile-agent'
  //     description = '从用户对话中抽取画像'
  abstract readonly agentId: string       // "我是谁"（如 'profile-agent'）
  abstract readonly description: string   // "我干啥的"（如 '抽取用户画像'）

  // ──────────────────────────────────────────────────────
  // 【抽象方法】execute — 子类必须实现的"具体干活"逻辑
  // ──────────────────────────────────────────────────────
  //   protected：外部不能直接调（只能通过 run() 调）
  //   abstract：子类必须实现
  //   场景：ProfileAgent 里实现：
  //     protected async execute(input, ctx) {
  //       const prompt = buildPrompt(input)
  //       const resp = await callLLM(prompt)
  //       return parseProfile(resp)
  //     }
  protected abstract execute(input: TInput, ctx: AgentContext): Promise<TOutput>

  // ──────────────────────────────────────────────────────
  // 【公共方法】run — 外部统一的调用入口（模板方法）
  // ──────────────────────────────────────────────────────
  //   这是"模板方法模式"的核心：骨架在基类，细节在子类
  //   外部都调 profileAgent.run()，不直接调 execute()
  //
  //   async：内部有 await（异步操作）
  //   Promise<AgentResult<TOutput>>：返回 Promise，resolve 值是 AgentResult
  //
  //   场景：routes/chat.ts 调：
  //     const result = await profileAgent.run(
  //       { userMessage, history },
  //       ctx
  //     )
  async run(input: TInput, ctx: AgentContext): Promise<AgentResult<TOutput>> {
    // ① 开始计时（毫秒时间戳）
    //   Date.now() → 1690000000000（自 1970-01-01 起的毫秒数）
    const start = Date.now()

    // ② 记下执行前的 token 余额
    //   执行完用 budget.used - tokensBefore 算消耗
    //   场景：tokensBefore = 5000 → 执行后 budget.used = 5920 → 消耗 920
    const tokensBefore = ctx.budget.getStatus().used

    try {
      // ③ 调子类的 execute() — 这是子类写的"具体干啥活"的方法
      //   this.execute 实际调用的是子类 ProfileAgent.execute
      //   await：等异步操作完成（调 LLM 是异步的）
      const data = await this.execute(input, ctx)

      // ④ 成功 → 交一份"工作汇报单"（AgentResult）
      //   data 是 execute 的返回值（如 ProfilePatch 对象）
      return {
        agentId: this.agentId,     // 谁干的活（'profile-agent'）
        ok: true,                  // 干成了
        data,                      // 干了什么结果
        // 花了多少 token = 执行后的余额 - 执行前的余额
        tokensUsed: ctx.budget.getStatus().used - tokensBefore,
        // 花了多少毫秒 = 现在的毫秒数 - 开始时的毫秒数
        durationMs: Date.now() - start,
      }
    } catch (e) {
      // ⑤ 失败了 → 先写到踩坑本上（反循环器会记录）
      //   场景：LLM API 超时、JSON 解析失败等
      //   loopDetector 记下错误，连续 5 次错就触发循环警告
      ctx.loopDetector.recordError((e as Error).message)
      //              ↑ e as Error：类型断言
      //              TS 默认 catch 的 e 是 unknown，断言成 Error 才能用 .message

      // 同样交汇报单，只是标记 ok: false
      return {
        agentId: this.agentId,
        ok: false,                                            // 干砸了
        error: (e as Error).message,                          // 错误原因
        tokensUsed: ctx.budget.getStatus().used - tokensBefore,
        durationMs: Date.now() - start,
      }
    }
    // 注意：无论成功还是失败，汇报单都有耗时和 token 消耗 — 可观测！
    //   这样 routes 层可以根据 durationMs 判断是否慢查询
    //   可以根据 tokensUsed 算总成本
  }
}
