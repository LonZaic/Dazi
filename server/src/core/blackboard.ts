// ============================================================
// blackboard.ts — 共享黑板（三 Agent 协作的解耦核心）
// 文件路径：server/src/core/blackboard.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这文件是三个 Agent 之间的"公司内部公告板"。                ║
// ║  规则：Agent 之间不能直接打电话（不互相 import），          ║
// ║        要传话只能往黑板上贴便条，谁需要谁自己来看。         ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 为什么需要黑板？直接互相调用不行吗？▼▼▼
//
//   假设不用黑板，直接互相调用：
//     profileAgent.run() → matchAgent.run() → iceBreaker.run()
//
//   问题 1：循环依赖
//     profileAgent.ts 要 import matchAgent.ts
//     matchAgent.ts 也要 import profileAgent.ts（拿画像）
//     → Node.js 加载时死锁，跑不起来
//
//   问题 2：强耦合
//     matchAgent 改了返回值格式，所有调用方都得改
//     加新 Agent（如告别 Agent）要改所有现有 Agent
//
//   问题 3：异步难处理
//     profileAgent 是异步的（调 LLM 要 5 秒）
//     matchAgent 怎么知道画像写完了？轮询？回调？太麻烦
//
//   黑板方案：
//     ProfileAgent 写完画像 → blackboard.write('latest_profile', 画像数据)
//     MatchAgent 想用画像 → blackboard.read('latest_profile')
//     → 互不认识，零依赖，异步天然支持
//
// ▼▼▼ 具体情景：小王聊天的数据流 ▼▼▼
//
//   ① 小王发"我喜欢跑步和羽毛球"
//   ② ProfileAgent 调 LLM 抽出画像：
//      { interests: [{name:'跑步', confidence:0.9}, {name:'羽毛球', confidence:0.8}] }
//   ③ ProfileAgent 把画像贴到黑板：
//      blackboard.write('profile-agent', 'latest_profile', 画像, 'profile_patch')
//      └─ 黑板内部：entries 数组多一条便条
//      └─ 黑板内部：keyIndex.set('latest_profile', 0) 建索引
//   ④ 小王点"开始匹配"
//   ⑤ MatchAgent 从黑板读画像：
//      const entry = blackboard.read('latest_profile')
//      └─ 黑板内部：keyIndex.get('latest_profile') → 0
//      └─ 黑板内部：entries[0] → 返回那条便条
//   ⑥ MatchAgent 把画像转成查询向量，做召回排序
//   ⑦ MatchAgent 把匹配结果贴到黑板：
//      blackboard.write('match-agent', 'latest_match', 候选列表, 'match_result')
//   ⑧ IceBreaker 从黑板读匹配结果，生成破冰话术
//
// ════════════════════════════════════════════════════════════
//  【数据结构示意图】
// ════════════════════════════════════════════════════════════
//
//   entries: BlackboardEntry[]          keyIndex: Map<string, number>
//   ┌────────────────────────────┐      ┌──────────────────────┐
//   │ [0] latest_profile         │ ←──→ │ 'latest_profile' → 0 │
//   │     agentId: 'profile-...' │      │ 'latest_match'    → 1│
//   │     value: {interests:[...]}│      └──────────────────────┘
//   │     category: 'profile_patch'│
//   │     timestamp: 1699999999999│      索引作用：read(key) 不用遍历数组，
//   │                            │      直接 O(1) 拿到位置
//   │ [1] latest_match           │
//   │     agentId: 'match-agent' │
//   │     value: [{userId:...}]  │
//   │     category: 'match_result'│
//   │     timestamp: 1700000000000│
//   └────────────────────────────┘
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - type BBCategory = 'A' | 'B' | 'C'
//     → 联合类型，便条分类用（防止乱写分类名）
//
//   - interface Blackboard
//     → 只定义"能做什么"（write/read/...），不定义"怎么做"
//     → 这是"面向接口编程"，方便换实现（如换成 Redis 版）
//
//   - 闭包（closure）
//     → createBlackboard() 里的 entries 和 keyIndex 是局部变量
//     → 但返回的对象里的函数能"记住"这俩变量
//     → 外面只能通过 write/read 操作，不能直接改 entries（封装）
//
//   - Record<BBCategory, BlackboardEntry[]>
//     → Record<K, V> 是 TS 工具类型，等价于 { [K]: V }
//     → 这里表示"以 BBCategory 为 key，BlackboardEntry[] 为 value 的字典"
// ============================================================

// ════════════════════════════════════════════════════════════
//  【类型 1】BBCategory — 便条的 5 种分类
// ════════════════════════════════════════════════════════════
//   像文件夹分类，方便后续按类别查询（readCategory）
//   场景：debug 时只看"画像类"便条，不看"匹配类"便条
// 文件路径：server/src/core/blackboard.ts
export type BBCategory =
  | 'profile_patch'   // 画像增量便条（ProfileAgent 写的）
                      //   场景：ProfileAgent 抽出"跑步 confidence:0.9"
                      //   内容：ProfilePatch 对象
                      //
  | 'match_result'    // 匹配结果便条（MatchAgent 写的）
                      //   场景：MatchAgent 召回+排序后返回 5 个候选
                      //   内容：Candidate[] 数组
                      //
  | 'icebreaker'      // 破冰话术便条（IceBreaker 写的）
                      //   场景：IceBreaker 生成 3 条话术
                      //   内容：string[] 数组
                      //
  | 'warning'         // 警告便条（出问题了贴一张）
                      //   场景：budget 超 90%，强制停 LLM 时贴一张
                      //   内容：警告信息字符串
                      //
  | 'decision'        // 阶段决策便条（编排器写的，默认类型）
                      //   场景：状态机转换时贴一张留痕
                      //   内容：决策描述

// ════════════════════════════════════════════════════════════
//  【类型 2】BlackboardEntry — 一张便条长什么样
// ════════════════════════════════════════════════════════════
// 文件路径：server/src/core/blackboard.ts
export interface BlackboardEntry {
  agentId: string      // 谁写的便条？
                       //   取值：'profile-agent' / 'match-agent' / 'ice-breaker' / 'orchestrator'
                       //   场景：debug 时看"这条画像是 ProfileAgent 写的，不是 MatchAgent 写的"
                       //
  key: string          // 便条标题（如 'latest_profile'）
                       //   作用：read(key) 按标题查便条
                       //   约定：'latest_xxx' 表示"最新的 xxx"（同标题会被覆盖）
                       //        'history_xxx' 表示"历史记录"（追加不覆盖）
                       //
  value: unknown       // 便条内容（可以是任何东西）
                       //   unknown 是 TS 的"安全 any"——比 any 严格
                       //   unknown 类型的值用之前必须先断言/检查类型
                       //   场景：profile_patch 类的 value 是 ProfilePatch 对象
                       //        match_result 类的 value 是 Candidate[] 数组
                       //
  category: BBCategory // 便条分类（5 种之一）
                       //   作用：按类别查
                       //
  timestamp: number    // 贴的时间（毫秒时间戳）
                       //   作用：排序（先贴的在前），debug 看时序
}

// ════════════════════════════════════════════════════════════
//  【类型 3】BlackboardSnapshot — 拍快照导出（debug 用）
// ════════════════════════════════════════════════════════════
//   场景：用户反馈"匹配结果不对"，开发者要看当时黑板状态
//        → 调 blackboard.snapshot() 拿到一个完整快照
//        → JSON.stringify 后存进 audit_log 或 conversations.meta_json
// 文件路径：server/src/core/blackboard.ts
export interface BlackboardSnapshot {
  entries: BlackboardEntry[]                        // 所有便条列表（按时间顺序）
  byCategory: Record<BBCategory, BlackboardEntry[]> // 按类别分组（5 个数组）
                                                    //   Record<K, V> = 以 K 为 key、V 为 value 的字典
                                                    //   场景：只看画像类 → snapshot.byCategory.profile_patch
  agentContributions: Record<string, number>        // 每个 Agent 写了多少条
                                                    //   场景：看 ProfileAgent 是不是写太多了（异常检测）
                                                    //   示例：{ 'profile-agent': 5, 'match-agent': 1 }
}

// ════════════════════════════════════════════════════════════
//  【类型 4】Blackboard — 黑板能做什么（接口定义）
// ════════════════════════════════════════════════════════════
//   只定义"能做什么"，不定义"怎么做"——这是面向接口编程
//   好处：明天想换 Redis 版黑板，只要实现这 8 个方法就行，调用方零改动
// 文件路径：server/src/core/blackboard.ts
export interface Blackboard {
  // 写便条（同 key 会覆盖，不同 key 会新增）
  write(
    agentId: string,                     // 谁写的
    key: string,                         // 便条标题
    value: unknown,                      // 便条内容
    category?: BBCategory,               // 分类（? 可选，默认 'decision'）
  ): void

  readAll(): BlackboardEntry[]           // 读所有便条（返回副本，防外部篡改）

  read(key: string): BlackboardEntry | undefined  // 按标题查一条
                                                   //   找到返回便条，没找到返回 undefined
                                                   //   场景：MatchAgent 读 'latest_profile'

  has(key: string): boolean              // 查某个标题的便条存不存在
                                         //   场景：MatchAgent 先 has('latest_profile') 再 read

  snapshot(): BlackboardSnapshot         // 拍快照（debug + 持久化）

  clear(): void                          // 清空黑板
                                         //   场景：用户删账号时调

  size(): number                         // 数有多少条便条
}

// ════════════════════════════════════════════════════════════
//  【工厂函数】createBlackboard — 造一块新黑板
// ════════════════════════════════════════════════════════════
//   谁调用：orchestrator.ts 的 getSession() 里给新用户发一块
//   返回值：实现了 Blackboard 接口的对象
//
//   闭包原理：
//     entries 和 keyIndex 是 createBlackboard 内部的局部变量
//     但返回的对象里的 write/read 函数能"访问"这俩变量
//     外部代码只能通过这些函数操作，不能直接 entries.push(...)
//     → 这就是"封装"，外部只能用暴露的接口，不能乱改内部状态
// 文件路径：server/src/core/blackboard.ts → createBlackboard()
export function createBlackboard(): Blackboard {
  // ① 便条数组：所有便条按时间顺序存这里
  //   每条便条是 BlackboardEntry 对象
  const entries: BlackboardEntry[] = []

  // ② 索引字典：key(便条标题) → 在 entries 数组里的位置(index)
  //   作用：read(key) 时不用遍历数组找，直接 O(1) 拿到位置
  //   场景：read('latest_profile') → keyIndex.get('latest_profile') → 0 → entries[0]
  const keyIndex = new Map<string, number>()

  // 返回一个对象，对象里的方法通过闭包共享 entries 和 keyIndex
  return {

    // ──────────────────────────────────────────────────────
    // 【方法 1】write — 写便条（核心方法，被 Agent 调用最多）
    // ──────────────────────────────────────────────────────
    //   场景：ProfileAgent 抽完画像调
    //        blackboard.write('profile-agent', 'latest_profile', 画像数据, 'profile_patch')
    //
    //   覆盖语义：同一个 key 后写的覆盖先写的
    //     原因：'latest_profile' 这种 key 只需要"最新值"
    //     如果要历史，用 'profile_v1'、'profile_v2' 不同 key
    // ──────────────────────────────────────────────────────
    write(agentId, key, value, category = 'decision') {
      // 参数默认值：category 不传时默认 'decision'
      //   = 是默认值语法，不是赋值

      // ① 先查索引：这个标题之前贴过没？
      const idx = keyIndex.get(key)
      //   Map.get(key) 找到返回 value（这里是 index 数字），找不到返回 undefined

      if (idx !== undefined) {
        // ② 贴过 → 直接覆盖那一行（同标题只保留最新）
        //   场景：ProfileAgent 第二次抽画像，覆盖 'latest_profile' 旧值
        entries[idx] = { agentId, key, value, category, timestamp: Date.now() }
        return  // 覆盖完就结束，不往下走（早返回，性能好）
      }

      // ③ 没贴过 → 新增一张便条
      //   先在索引里记下"这个标题 = 即将插入的位置"
      //   entries.length 是当前数组长度，也是 push 后新元素的 index
      keyIndex.set(key, entries.length)
      //   push：往数组末尾塞一个元素
      entries.push({ agentId, key, value, category, timestamp: Date.now() })
    },

    // ──────────────────────────────────────────────────────
    // 【方法 2】readAll — 读所有便条
    // ──────────────────────────────────────────────────────
    //   场景：snapshot() 里调用，或 debug 时看全部
    //   返回副本（浅拷贝）防外部篡改内部状态
    //     [...entries] 展开运算符：把数组"摊开"塞进新数组
    //     等价于 entries.slice()，都是浅拷贝
    //     浅拷贝：新数组是新对象，但里面的便条对象还是同一个引用
    //     （深度防篡改要 structuredClone，但开销大，这里浅拷贝够用）
    readAll() {
      return [...entries]
    },

    // ──────────────────────────────────────────────────────
    // 【方法 3】read — 按标题查一条便条
    // ──────────────────────────────────────────────────────
    //   场景：MatchAgent 调 blackboard.read('latest_profile') 拿画像
    //   返回值：找到返回 BlackboardEntry，没找到返回 undefined
    //   性能：O(1)（因为有 keyIndex 索引）
    read(key) {
      const idx = keyIndex.get(key)
      // 三元运算符：条件 ? 真值 : 假值
      return idx !== undefined ? entries[idx] : undefined
    },

    // ──────────────────────────────────────────────────────
    // 【方法 4】has — 查便条存不存在
    // ──────────────────────────────────────────────────────
    //   场景：MatchAgent 先 has('latest_profile') 判断有没有画像
    //        没有 → 跳过匹配（没画像没法匹配）
    has(key) {
      return keyIndex.has(key)
      //   Map.has(key)：返回 true/false
    },

    // ──────────────────────────────────────────────────────
    // 【方法 5】snapshot — 拍快照（debug + 持久化用）
    // ──────────────────────────────────────────────────────
    //   场景：每条 AI 消息都附带当时的黑板快照（存 conversations.meta_json）
    //        出 bug 时回放：看当时的画像/匹配结果是什么
    snapshot() {
      // ① 初始化按类别分组的字典（5 个空数组）
      //   as 断言：告诉 TS "我知道这是 BlackboardEntry[] 类型"
      //   （TS 推断不出来空数组的具体类型，需要 as 帮忙）
      const byCategory = {
        profile_patch: [] as BlackboardEntry[],
        match_result: [] as BlackboardEntry[],
        icebreaker: [] as BlackboardEntry[],
        warning: [] as BlackboardEntry[],
        decision: [] as BlackboardEntry[],
      }

      // ② 统计每个 Agent 写了多少条
      //   Record<string, number> = { [agentId: string]: number }
      const agentContributions: Record<string, number> = {}
      //   场景：最终返回 { 'profile-agent': 5, 'match-agent': 1 }

      // ③ 遍历所有便条，做两件事：
      //    - 按类别塞进对应的数组
      //    - 累计每个 Agent 的贡献数
      for (const e of entries) {
        // byCategory[e.category]：动态取属性
        //   e.category 是 'profile_patch' → byCategory['profile_patch']
        byCategory[e.category].push(e)

        // 累计 Agent 贡献数
        //   场景：第一次见 'profile-agent' → agentContributions['profile-agent'] 是 undefined
        //        undefined || 0 → 0，再 +1 → 1
        //        第二次见 'profile-agent' → 1 + 1 = 2
        agentContributions[e.agentId] = (agentContributions[e.agentId] || 0) + 1
      }

      // 返回快照对象（entries 是浅拷贝副本）
      return { entries: [...entries], byCategory, agentContributions }
    },

    // ──────────────────────────────────────────────────────
    // 【方法 6】clear — 清空黑板
    // ──────────────────────────────────────────────────────
    //   场景：用户删账号时调（隐私合规，不留痕）
    //        测试用例每个 case 前清空
    clear() {
      // entries.length = 0：数组清空的快速方法（比 entries = [] 快）
      //   原理：直接置 length 属性，数组所有元素被删除
      entries.length = 0
      keyIndex.clear()  // Map.clear()：清空字典
    },

    // ──────────────────────────────────────────────────────
    // 【方法 7】size — 数便条数量
    // ──────────────────────────────────────────────────────
    //   场景：监控告警"黑板便条超过 100 条了，是不是 Agent 在循环写？"
    size() {
      return entries.length
    },
  }
}
