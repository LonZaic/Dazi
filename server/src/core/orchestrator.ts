// ============================================================
// 编排器 — 三 Agent 协作状态机（content.txt 第3.1节）
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这文件是整个 Agent 系统的"店长"——它不亲自干活，只管:       ║
// ║   1. 给每个用户开一张"工单"（SessionContext）              ║
// ║   2. 盯着用户的状态，决定该让哪个 Agent 上工                ║
// ║   3. 三个 Agent 不能乱串，必须按状态机走                   ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：用户小王从注册到匹配的完整流程 ▼▼▼
//
//   ① 小王刚注册登录 → 第一次发消息"我喜欢跑步和羽毛球"
//      └─ chat.ts 调 getSession('小王ID', 'default')
//         └─ orchestrator 发现花名册里没有小王 → 新建一张工单：
//            state = 'CHATTING'（开始聊天）
//            blackboard = 一块空黑板（待会 ProfileAgent 往上贴画像）
//            budget = 一本新账本（待会记 token 花费）
//
//   ② ProfileAgent 偷偷干活：从"我喜欢跑步"里抽出兴趣
//      └─ profileAgent.run() 完事后调 transition(ctx, {type:'profile_updated', confidence:0.4})
//         └─ orchestrator 看：当前是 CHATTING，confidence=0.4 < 0.65
//            └─ 状态保持 CHATTING（画像还不够，继续聊）
//
//   ③ 小王又聊了 5 句话，ProfileAgent 抽出的 confidence 涨到 0.7
//      └─ transition({type:'profile_updated', confidence:0.7})
//         └─ orchestrator 看：CHATTING + confidence=0.7 ≥ 0.65
//            └─ 状态跳到 'PROFILE_READY'（画像够用了！）
//            └─ 前端看到这个状态变化 → "开始匹配"按钮亮起来
//
//   ④ 小王点"开始匹配"按钮
//      └─ match.ts 调 transition(ctx, {type:'match_requested'})
//         └─ orchestrator 看：当前是 PROFILE_READY → 允许跳
//            └─ 状态跳到 'MATCHING'（匹配中，请稍等）
//      └─ matchAgent 干活：向量召回 + 5维排序
//      └─ match.ts 调 transition(ctx, {type:'match_done'})
//         └─ orchestrator 看：当前是 MATCHING → 跳到 'MATCHED'
//            └─ 前端拿到候选列表，展示给小王
//
//   ⑤ 小王看上一个候选，点"生成破冰话术"
//      └─ match.ts 调 transition(ctx, {type:'icebreak_requested'})
//         └─ orchestrator 看：当前是 MATCHED → 跳到 'ICEBREAKING'
//      └─ iceBreaker 干活：生成 3 条破冰话术
//      └─ match.ts 调 transition(ctx, {type:'icebreak_done'})
//         └─ orchestrator 看：当前是 ICEBREAKING → 跳到 'DONE'
//
// ════════════════════════════════════════════════════════════
//  【为什么要用状态机？直接写函数调用链不行吗？】
// ════════════════════════════════════════════════════════════
//   假设不用状态机，直接写：
//     chat() → profile() → match() → icebreak()  ← 写死的链
//
//   问题 1：用户聊一半关了浏览器，明天再来怎么办？
//     └─ 状态机能记住"昨天停在 PROFILE_READY"，今天直接点匹配就行
//
//   问题 2：ProfileAgent 是异步的（要调 LLM，可能 5 秒才回来）
//     └─ 状态机能保证"画像没抽完时，匹配按钮是灰的"
//
//   问题 3：用户重复点"开始匹配"会不会出问题？
//     └─ 状态机能拒绝非法转换（MATCHING 中再点 → 不允许，防并发）
//
//   问题 4：出 bug 了想复盘？
//     └─ 状态机 + 信号是可重放的：把信号序列重新跑一遍，结果一样
//
// ════════════════════════════════════════════════════════════
//  【数据流图】
// ════════════════════════════════════════════════════════════
//
//   routes/chat.ts                 routes/match.ts
//        │                              │
//        ▼                              ▼
//   getSession(userId)            transition(match_requested)
//        │                              │
//        ▼                              ▼
//   ┌─────────────────────────────────────────────┐
//   │  sessions: Map<userId, SessionContext>      │  ← 本文件管理的"花名册"
//   │  ┌─────────────────────────────────────┐    │
//   │  │ SessionContext {                    │    │
//   │  │   state: CHATTING→...→DONE          │    │  ← transition() 改这个
//   │  │   blackboard: 黑板（Agent 间通信）   │    │
//   │  │   budget: token 账本                │    │
//   │  │   loopDetector: 防死循环器          │    │
//   │  │ }                                   │    │
//   │  └─────────────────────────────────────┘    │
//   └─────────────────────────────────────────────┘
//        ▲                              ▲
//        │                              │
//   profileAgent.run()              matchAgent.run()
//   （抽完画像发信号）              （匹配完发信号）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - export type SessionState = 'A' | 'B' | 'C'
//     → 联合类型，只能取这几个字符串字面量之一
//     → 好处：写代码时 TS 会自动补全，写错（如 'CHATING' 拼错）会立刻报错
//
//   - interface SessionContext → 定义"一个会话里必须有哪些字段"
//     → 类比：相当于数据库表的 schema
//
//   - Map<string, SessionContext>
//     → Map 是 JS 内置的字典类型，比普通对象更适合做"按 key 查 value"
//     → Map 的 key 可以是任意类型，普通对象的 key 只能是字符串
//     → Map 有 .get()/.set()/.delete()/.has() 方法
//
//   - sessions.get(userId) 返回 SessionContext | undefined
//     → 找到了返回会话，没找到返回 undefined（JS 没有 null 安全，TS 帮你标出来）
//     → 所以下面要用 if (!ctx) 判断
// ============================================================

// ─── import：从别的文件搬工具过来 ───
//   createBlackboard 是"造黑板的工厂函数"
//   type Blackboard 是"黑板的类型定义"（只用于类型检查，运行时不占空间）
import { createBlackboard, type Blackboard } from './blackboard.js'
//   ↑ 这俩从 blackboard.ts 拿：黑板（Agent 间贴便条用的）
import { createLoopDetector, type LoopDetector } from './antiloop.js'
//   ↑ 这俩从 antiloop.ts 拿：防死循环器（同一件事干太多次就报警）
import { createBudgetTracker, type BudgetTracker } from './tokenBudget.js'
//   ↑ 这俩从 tokenBudget.ts 拿：token 账本（记花了多少钱）

// ════════════════════════════════════════════════════════════
//  【核心类型 1】SessionState — 会话有哪几种状态
// ════════════════════════════════════════════════════════════
//   联合类型 = 只能取这几个字符串字面量之一
//   顺序就是用户的典型流程：CHATTING → PROFILE_READY → MATCHING → MATCHED → ICEBREAKING → DONE
// 文件路径：server/src/core/orchestrator.ts
export type SessionState =
  | 'CHATTING'       // ① 初始状态：用户在和 ProfileAgent 聊天，画像采集中
                     //    情景：小王刚注册，发了"我喜欢跑步"，画像 confidence=0.3
                     //    前端表现：聊天气泡正常，"开始匹配"按钮灰色不可点
                     //
  | 'PROFILE_READY'  // ② 画像够用了：confidence ≥ 0.65
                     //    情景：小王聊了 6 句话，画像 confidence=0.7
                     //    前端表现："开始匹配"按钮亮起来，可以点了
                     //
  | 'MATCHING'       // ③ 短暂状态：MatchAgent 正在干活（召回+排序，<2秒）
                     //    情景：小王点了"开始匹配"，后端在跑向量召回
                     //    前端表现：loading 转圈
                     //
  | 'MATCHED'        // ④ 匹配完成：候选列表已出，用户在看
                     //    情景：matchAgent 返回 5 个候选，前端展示卡片
                     //    前端表现：候选卡片列表，每个卡片有"破冰话术"按钮
                     //
  | 'ICEBREAKING'    // ⑤ 短暂状态：IceBreaker 正在生成破冰话术（调 LLM，几秒）
                     //    情景：小王点了"破冰话术"按钮
                     //    前端表现：loading 转圈
                     //
  | 'DONE'           // ⑥ 全部完成：破冰话术已生成
                     //    情景：iceBreaker 返回 3 条话术
                     //    前端表现：显示话术，用户可以复制去私信

// ════════════════════════════════════════════════════════════
//  【核心类型 2】SessionContext — 一个用户的"工单"长什么样
// ════════════════════════════════════════════════════════════
//   每个用户对应一个 SessionContext，存他当前的状态和所有工具
//   这个对象在用户整个生命周期内一直存在（除非服务重启）
// 文件路径：server/src/core/orchestrator.ts
export interface SessionContext {
  userId: string              // 用户 ID（谁的工单？如 "u_abc123"）
                              //   来源：登录后从 JWT 里解出来，由 routes/chat.ts 传入
                              //
  tenantId: string            // 租户 ID（哪家公司？如 "default"）
                              //   多租户设计：未来一套系统给多家公司用，互不可见
                              //   现在 demo 只有 "default" 一个租户
                              //
  state: SessionState         // 当前状态（6 种之一）
                              //   初始 'CHATTING'，由 transition() 改变
                              //   前端通过 /chat/message 接口的响应拿这个值，
                              //   据此决定按钮显隐/可点
                              //
  blackboard: Blackboard      // 这个用户专属的"公告板"
                              //   ProfileAgent 写：贴 "画像 patch" 便条
                              //   MatchAgent   读：拿画像去生成查询向量
                              //   MatchAgent   写：贴 "匹配结果" 便条
                              //   IceBreaker   读：拿匹配结果生成话术
                              //   作用：三个 Agent 不直接互相调用，靠黑板解耦
                              //
  loopDetector: LoopDetector  // 防死循环器（这个用户专属）
                              //   场景：ProfileAgent 抽不出新画像，反复调 LLM 同样的输入
                              //   作用：检测到连续 3 次相同操作 → 报警停止
                              //
  budget: BudgetTracker       // token 账本（这个用户专属）
                              //   场景：小王狂聊天，每次都调 LLM 烧钱
                              //   作用：累计到 18 万 token（90%）→ 强制停 LLM，降级规则模式
                              //
  profileConfidence: number   // 画像置信度（0-1）
                              //   来源：ProfileAgent 每次抽完画像回传
                              //   用途：≥0.65 时状态机从 CHATTING → PROFILE_READY
                              //   前端会显示进度条"画像完成度：70%"
                              //
  lastMatchedAt?: number      // 上次匹配的时间戳（毫秒）
                              //   ? 表示"可选字段"——可以没有
                              //   用途：限频（防用户狂点匹配），UI 显示"3 分钟前匹配过"
}

// ════════════════════════════════════════════════════════════
//  【全局变量】花名册 — 所有用户的工单都在这里
// ════════════════════════════════════════════════════════════
//   Map<key, value>：JS 内置字典类型
//   - key: userId（字符串，如 "u_abc123"）
//   - value: SessionContext 对象
//
//   ⚠️ 注意：这是"内存存储"，进程重启就没了！
//   - 生产环境应该用 Redis 替代（持久化 + 多机共享）
//   - 当前 demo 重启后所有用户状态归零（重新进入 CHATTING）
//   - 但数据库里的画像/对话/匹配记录都还在，状态机能根据数据重建
const sessions = new Map<string, SessionContext>()

// ════════════════════════════════════════════════════════════
//  【函数 1】getSession — 拿用户工单，没有就开一张新的
// ════════════════════════════════════════════════════════════
//   情景：小王第一次发消息，花名册里没有他 → 开新工单
//        小王第二次发消息，花名册里有他 → 直接返回旧工单
//
//   调用方：routes/chat.ts 每次收到消息都调
//            routes/match.ts 匹配前调
//            routes/profile.ts 查画像前调
//
//   参数：
//     userId: string   → 用户 ID（谁？）
//     tenantId: string → 租户 ID（哪家公司？多租户隔离）
//
//   返回值：SessionContext → 这个用户的工单（一定有，没有就现场造）
// 文件路径：server/src/core/orchestrator.ts → getSession()
export function getSession(userId: string, tenantId: string): SessionContext {
  // ① 从花名册按 userId 查工单
  //   Map.get(key) 找到返回 value，找不到返回 undefined
  let ctx = sessions.get(userId)

  if (!ctx) {
    // ② 没找到 → 小王是第一次来，开一张新工单
    //   下面的对象字面量用了"属性简写"：
    //   - userId,         等同于 userId: userId（变量名和属性名一样时省略）
    //   - tenantId,       等同于 tenantId: tenantId
    ctx = {
      userId,                          // 记下"这是小王的工单"
      tenantId,                        // 记下"小王属于 default 租户"
      state: 'CHATTING',               // 初始状态：聊天中（画像还没开始采）
      blackboard: createBlackboard(),  // 发一块空黑板（待会 Agent 往上贴便条）
      loopDetector: createLoopDetector(),  // 发一个反循环器
      budget: createBudgetTracker(),       // 发一本 token 账本（默认 20 万预算）
      profileConfidence: 0,                // 画像置信度从 0 开始（啥都不知道）
      // lastMatchedAt 不写 → undefined（还没匹配过）
    }
    // ③ 把新工单存进花名册，下次小王再发消息直接拿
    //   Map.set(key, value)
    sessions.set(userId, ctx)
  }
  // ④ 返回工单（旧的或刚建的）
  return ctx
}

// ════════════════════════════════════════════════════════════
//  【函数 2】transition — 信号驱动状态转换（核心！）
// ════════════════════════════════════════════════════════════
//   这是状态机的"心脏"——所有状态变化都走这个函数
//
//   为什么用"信号驱动"而不是"自动跳转"？
//   - 自动跳转：CHATTING → 自动跳 PROFILE_READY（怎么跳？谁触发？）
//   - 信号驱动：必须有人发 'profile_updated' 信号才会跳
//     → 谁发信号？ProfileAgent 抽完画像发
//     → 什么时候发？LLM 返回结果后
//     → 这样所有状态变化都有明确的责任方和时机
//
//   调用方：
//   - profileAgent.run() 完事后发 'profile_updated'
//   - routes/match.ts 收到点击发 'match_requested'
//   - matchAgent.run() 完事后发 'match_done'
//   - routes/match.ts 收到点击发 'icebreak_requested'
//   - iceBreaker.run() 完事后发 'icebreak_done'
//
//   参数：
//     ctx: SessionContext → 改谁的工单
//     signal: { type, confidence? } → 收到什么信号
//       - type: 5 种信号之一（联合类型）
//       - confidence: 可选，只有 'profile_updated' 会带
//
//   返回值：SessionState → 转换后的新状态（调用方可以拿来判断后续做什么）
// 文件路径：server/src/core/orchestrator.ts → transition()
export function transition(
  ctx: SessionContext,
  signal: {
    // 联合类型：type 只能是这 5 个字符串之一
    type:
      | 'profile_updated'     // 画像更新了（ProfileAgent 异步抽取完发）
      | 'match_requested'     // 用户点了"开始匹配"按钮（前端触发）
      | 'match_done'          // MatchAgent 召回+排序完成
      | 'icebreak_requested'  // 用户点了"生成破冰话术"按钮
      | 'icebreak_done'       // IceBreaker 生成完话术
    // ? 表示"可选字段"——只有 'profile_updated' 信号会带 confidence
    // 其他信号不带（TS 不会强制要求传）
    confidence?: number
  }
): SessionState {
  // switch-case：根据信号类型走不同分支
  // 比 if-else 链更清晰，TS 还会检查是否覆盖了所有 case
  switch (signal.type) {

    // ──────────────────────────────────────────────────────
    // 信号 1：画像更新了
    //   谁发：ProfileAgent.run() 内部，每次抽完画像都发一次
    //   场景：小王发"我喜欢跑步"→ ProfileAgent 抽出 confidence=0.3 → 发信号
    //        小王又发"周末喜欢打球"→ ProfileAgent 抽出 confidence=0.55 → 发信号
    //        小王又发"找跑步搭子"→ ProfileAgent 抽出 confidence=0.7 → 发信号
    //          → 这次 confidence ≥ 0.65，状态从 CHATTING 跳到 PROFILE_READY
    // ──────────────────────────────────────────────────────
    case 'profile_updated':
      // 如果信号带了 confidence，更新工单上的置信度
      // !== undefined 是 TS 友好的判断方式（confidence 可能是 0，0 是合法值）
      if (signal.confidence !== undefined) ctx.profileConfidence = signal.confidence
      // 检查：当前是 CHATTING 且置信度达标 → 跳到 PROFILE_READY
      // 为什么必须 CHATTING？防止已经匹配完了再聊一句又跳回去
      if (ctx.state === 'CHATTING' && ctx.profileConfidence >= 0.65) {
        ctx.state = 'PROFILE_READY'
        // 此处前端会收到新状态 → "开始匹配"按钮亮起来
      }
      break  // 跳出 switch（每个 case 必须以 break 或 return 结尾，否则会"穿透"到下一个 case）

    // ──────────────────────────────────────────────────────
    // 信号 2：用户点了"开始匹配"
    //   谁发：routes/match.ts 收到 POST /match/run 请求时
    //   场景：小王看到"开始匹配"按钮亮了，点了一下
    //   允许的来源状态：CHATTING / PROFILE_READY / MATCHED
    //     - CHATTING：画像不够也允许匹配（降级模式，给用户兜底）
    //     - PROFILE_READY：正常流程
    //     - MATCHED：用户看了候选不满意，想重新匹配
    //   不允许：MATCHING（正在匹配中，防重复点击）
    //           ICEBREAKING（正在生成话术，得等完）
    // ──────────────────────────────────────────────────────
    case 'match_requested':
      if (ctx.state === 'CHATTING' || ctx.state === 'PROFILE_READY' || ctx.state === 'MATCHED') {
        ctx.state = 'MATCHING'
        // 前端收到 MATCHING → 显示 loading
      }
      break

    // ──────────────────────────────────────────────────────
    // 信号 3：MatchAgent 匹配完成
    //   谁发：routes/match.ts 在 matchAgent.run() 返回后发
    //   场景：matchAgent 跑了 1.5 秒，返回 5 个候选 → 发这个信号
    //   守卫：只有 MATCHING 状态下收到才有效（防乱序）
    //     - 比如用户点了匹配又立马点了取消，状态变了，迟到信号会被丢弃
    // ──────────────────────────────────────────────────────
    case 'match_done':
      if (ctx.state === 'MATCHING') {
        ctx.state = 'MATCHED'
        ctx.lastMatchedAt = Date.now()  // 记下匹配时间，用于限频和 UI 显示
        // 前端收到 MATCHED + 候选列表 → 渲染候选卡片
      }
      break

    // ──────────────────────────────────────────────────────
    // 信号 4：用户点了"生成破冰话术"
    //   谁发：routes/match.ts 收到 POST /match/icebreak 请求时
    //   场景：小王看了候选列表，看上一个叫"林夕"的，点了"破冰话术"按钮
    //   守卫：只有 MATCHED 状态能跳（必须先有候选列表）
    //     - CHATTING 中点？不行（没候选给谁破冰）
    //     - MATCHING 中点？不行（匹配还没完）
    // ──────────────────────────────────────────────────────
    case 'icebreak_requested':
      if (ctx.state === 'MATCHED') ctx.state = 'ICEBREAKING'
      break

    // ──────────────────────────────────────────────────────
    // 信号 5：IceBreaker 话术生成完成
    //   谁发：routes/match.ts 在 iceBreaker.run() 返回后发
    //   场景：iceBreaker 调 LLM 生成了 3 条话术 → 发这个信号
    //   守卫：只有 ICEBREAKING 状态下收到才有效
    // ──────────────────────────────────────────────────────
    case 'icebreak_done':
      if (ctx.state === 'ICEBREAKING') ctx.state = 'DONE'
      // 前端收到 DONE + 话术列表 → 显示给用户复制
      break
  }
  return ctx.state  // 返回新状态，调用方可以拿来判断后续做什么
}

// ════════════════════════════════════════════════════════════
//  【函数 3】resetSession — 重置工单（删了，下次进来重新建）
// ════════════════════════════════════════════════════════════
//   谁调用：routes/privacy.ts 的 DELETE /privacy/account
//           （用户删账号时，把工单也清了）
//
//   场景：小王不想用了，点"删除账号"
//         → 数据库删用户（外键级联删画像/对话/匹配）
//         → 内存里删工单（sessions.delete）
//         → 下次（不会再有下次了，账号都删了）
//
//   为什么需要这个函数？
//   - 不删的话，工单会一直占内存（内存泄漏）
//   - 删了用户但工单还在，下次有人用这个 userId 注册会拿到旧工单（脏数据）
// 文件路径：server/src/core/orchestrator.ts → resetSession()
export function resetSession(userId: string): void {
  // Map.delete(key) → 删除指定 key，返回是否删除成功
  // void 表示这个函数不返回任何东西
  sessions.delete(userId)
}
