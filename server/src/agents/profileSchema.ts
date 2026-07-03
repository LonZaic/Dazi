// ============================================================
// profileSchema.ts — 画像数据契约（系统的核心数据结构）
// 文件路径：server/src/agents/profileSchema.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这是"画像"的数据结构定义——画像长什么样、怎么合并更新、     ║
// ║  怎么算置信度。这是整个系统的"核心数据契约"。                ║
// ║                                                            ║
// ║  画像 = 兴趣数组 + 社交风格 + 活跃时段 + 目标 + 限制条件    ║
// ║  每个兴趣带置信度（confidence 0-1）和证据（evidence 原话） ║
// ║                                                            ║
// ║  核心原则：不覆盖，只累加                                  ║
// ║  今天聊到跑步，明天聊到音乐，两条都留。                    ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王的画像演化过程 ▼▼▼
//
//   第 1 天注册：
//     createEmptyProfile('小王') →
//     {
//       basic: { userId:'小王', createdAt:..., version:0 },
//       interests: [],
//       socialStyle: { energy:'unknown', depth:'unknown' },
//       schedule: [], goal: '', constraints: [],
//       confidence: 0   ← 啥都不知道，置信度 0
//     }
//
//   第 1 天聊"我最近开始跑步了"：
//     ProfileAgent 抽出 patch = { interests:[{name:'跑步', confidence:0.8, evidence:'我最近开始跑步了'}] }
//     applyPatch(画像, patch) →
//     {
//       ...
//       interests: [{ name:'跑步', confidence:0.8, evidence:['我最近开始跑步了'] }],
//       confidence: 0.42   ← 强兴趣 0.15 + 平均置信度 0.16 + 时段 0 + ... = 0.42
//       basic.version: 1
//     }
//     → 还没到 0.65，orchestrator 状态还是 CHATTING
//
//   第 2 天聊"我比较内向，喜欢周末爬山"：
//     patch = {
//       interests:[{name:'爬山', confidence:0.9, evidence:'喜欢周末爬山'}],
//       socialStyle: { energy:'introvert' },
//       schedule: ['weekend']
//     }
//     applyPatch 后：
//     {
//       interests: [跑步(0.8), 爬山(0.9)],
//       socialStyle: { energy:'introvert', depth:'unknown' },
//       schedule: ['weekend'],
//       confidence: 0.72   ← 强兴趣 0.3 + 平均 0.17 + 风格 0.15 + 时段 0.05 + 目标 0 = 0.72
//       basic.version: 2
//     }
//     → ≥ 0.65，orchestrator 状态变成 PROFILE_READY
//     → 前端"开始匹配"按钮亮起来
//
//   后续聊"周末爬山搭子，只在朝阳区"：
//     patch = { goal:'周末爬山搭子', constraints:['只在朝阳区'] }
//     applyPatch 后：
//     {
//       ...
//       goal: '周末爬山搭子',
//       constraints: ['只在朝阳区'],
//       confidence: 0.82   ← 加了目标 +0.1
//       basic.version: 3
//     }
//
// ════════════════════════════════════════════════════════════
//  【数据流】
// ════════════════════════════════════════════════════════════
//
//   用户聊天
//        │
//        ▼
//   ProfileAgent.extractViaLLM()  ← 调 LLM 抽出 patch
//        │
//        ▼
//   applyPatch(画像, patch)        ← 增量合并
//        │
//        ├──→ 存到 DB（profiles 表）
//        ├──→ blackboard.write('latest_profile', next)  ← 给 MatchAgent 用
//        └──→ confidence ≥ 0.65 → orchestrator 状态 PROFILE_READY
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - export interface → 定义数据结构的"身份证"，导出给别的文件用
//   - ? 可选属性 → 可以不填
//   - ... 展开运算符 → 浅拷贝对象
//   - ?? 空值合并 → a ?? b 意思是 a 如果是 null/undefined 就用 b
//   - Partial<T> → 把 T 的所有字段变成可选
//   - 字面量联合类型 → 'introvert' | 'extrovert' | ...
// ============================================================

// ════════════════════════════════════════════════════════════
//  【类型 1】InterestEntry — 单条兴趣记录
// ════════════════════════════════════════════════════════════
//   场景：小王说"我喜欢晨跑" → 抽出一条
//     { name:'跑步', confidence:0.8, evidence:['我喜欢晨跑'] }
// 文件路径：server/src/agents/profileSchema.ts
export interface InterestEntry {
  name: string               // 兴趣名（如 "跑步"）
                             //   不区分大小写合并（"跑步" = "跑步 " = "RUNNING"）
                             //
  confidence: number         // 置信度 0-1（0.8 = 八成把握用户真喜欢）
                             //   0-0.4：弱（随口一提）
                             //   0.5-0.7：中（多次提到/有细节）
                             //   0.8-1.0：强（明确说"我喜欢"/"我经常"）
                             //   ≥0.5 算"强兴趣"，参与置信度计算
                             //
  evidence: string[]         // 证据数组（用户原话片段）
                             //   场景：['我喜欢晨跑', '每周跑三次']
                             //   最多保留 5 条（超了删最早）
                             //   用途：debug 看为啥抽这个兴趣 + 前端可展示
}

// ════════════════════════════════════════════════════════════
//  【类型 2】SocialStyle — 社交风格
// ════════════════════════════════════════════════════════════
//   这个人外向还是内向？喜欢浅聊还是深聊？
//   MatchAgent 用这个匹配相似风格的人
// 文件路径：server/src/agents/profileSchema.ts
export interface SocialStyle {
  energy: 'introvert'   // 内向型（安静、独处、小型社交）
         | 'extrovert'   // 外向型（热闹、群体活动）
         | 'ambivert'    // 混合型（两头都沾）
         | 'unknown'     // 还不知道（默认值）
         //   字面量联合类型：TS 会校验只能取这几个字符串
         //   场景：小王说"我比较内向" → energy = 'introvert'
         //
  depth: 'surface'       // 浅社交（闲聊、搭伴做事就行）
        | 'deep'         // 深度交流（想交心、认真聊）
        | 'mixed'        // 混合型
        | 'unknown'      // 还不知道（默认值）
        //   场景：小王说"想找认真聊得来的朋友" → depth = 'deep'
}

// ════════════════════════════════════════════════════════════
//  【类型 3】Profile — 完整画像
// ════════════════════════════════════════════════════════════
//   这就是"用户画像"的全部字段
//   存到 DB 的 profiles 表里，每次更新 version +1
// 文件路径：server/src/agents/profileSchema.ts
export interface Profile {
  basic: {                  // 基础信息
    userId: string          // 用户 ID（谁）
                            //   场景：'user-小王-001'
                            //
    createdAt: number       // 创建时间（毫秒时间戳）
                            //   场景：Date.now() → 1690000000000
                            //   用于：用户注册时间统计
                            //
    version: number         // 版本号（每更新一次 +1）
                            //   场景：聊了 3 轮 → version = 3
                            //   用于：追踪变更历史、并发控制
  }
  interests: InterestEntry[]  // 兴趣列表（可以有多个）
                              //   场景：[跑步(0.8), 爬山(0.9), 音乐(0.6)]
                              //
  socialStyle: SocialStyle    // 社交风格
                              //   场景：{ energy:'introvert', depth:'deep' }
                              //
  schedule: string[]          // 活跃时段
                              //   场景：['evening', 'weekend']
                              //   MatchAgent 用这个匹配同时段活跃的人
                              //
  goal: string                // 找搭子目标
                              //   场景：'周末爬山搭子'
                              //   MatchAgent 优先匹配 goal 相似的人
                              //
  constraints: string[]       // 限制条件
                              //   场景：['只在朝阳区', '不要夜跑']
                              //   MatchAgent 用这个过滤掉不合适的候选
                              //
  confidence: number          // 整体画像置信度 0-1
                              //   ≥0.65 才能匹配（orchestrator 触发 PROFILE_READY）
                              //   computeConfidence() 算出来的
}

// ════════════════════════════════════════════════════════════
//  【类型 4】ProfilePatch — 画像增量 patch
// ════════════════════════════════════════════════════════════
//   ProfileAgent 每次抽取的就是这个
//   不是完整画像，而是"这次对话新发现了什么"
//   全部字段都是可选的（?）— 因为每次可能只发现一个字段
//
//   场景 1：小王发"我最近开始跑步了"
//     patch = { interests:[{name:'跑步', confidence:0.8, evidence:'我最近开始跑步了'}] }
//     （只填了 interests，其他都是 undefined）
//
//   场景 2：小王发"我比较内向"
//     patch = { socialStyle:{ energy:'introvert' } }
//     （只填了 socialStyle.energy，depth 没填）
// 文件路径：server/src/agents/profileSchema.ts
export interface ProfilePatch {
  interests?: Array<{          // 新发现的兴趣（? 可选）
    name: string               // 兴趣名
    confidence: number         // 置信度
    evidence?: string          // 可选：证据（用户原话片段）
                              //   注意：这里 evidence 是单个 string
                              //   而 InterestEntry.evidence 是 string[]
                              //   合并时单个会塞进数组
  }>
  socialStyle?: Partial<SocialStyle>  // 社交风格（Partial = 每个字段都可选）
  //             ↑ Partial 是 TS 内置工具类型
  //             把 { energy:string, depth:string } 变成 { energy?:string, depth?:string }
  //             场景：patch 只填 energy 不填 depth 也能通过类型检查
  //
  schedule?: string[]          // 活跃时段
  goal?: string                // 目标
  constraints?: string[]       // 限制条件
}

// ════════════════════════════════════════════════════════════
//  【工厂函数】createEmptyProfile — 创建空白画像
// ════════════════════════════════════════════════════════════
//   调用方：用户首次注册时（routes/auth.ts 或 db/userRepo.ts）
//   场景：小王刚注册 → createEmptyProfile('小王') → 存到 DB
// 文件路径：server/src/agents/profileSchema.ts → createEmptyProfile()
export function createEmptyProfile(userId: string): Profile {
  return {
    basic: { userId, createdAt: Date.now(), version: 0 },
    interests: [],  // 空的兴趣列表
    socialStyle: { energy: 'unknown', depth: 'unknown' },  // 啥都不知道
    schedule: [],  // 空数组
    goal: '',      // 空字符串
    constraints: [],  // 空数组
    confidence: 0,   // 置信度从 0 开始
  }
}

// ════════════════════════════════════════════════════════════
//  【核心函数 1】applyPatch — 增量合并 patch 到画像
// ════════════════════════════════════════════════════════════
//   "贴新便条，不覆盖旧的"
//
//   调用方：ProfileAgent.extractViaLLM() 拿到 patch 后调
//   场景：小王聊"我最近开始跑步了" → patch = { interests:[{name:'跑步',...}] }
//        applyPatch(旧画像, patch) → 新画像（带跑步兴趣）
//
//   规则：
//   1. 兴趣：同名合并（如两次都提到"跑步" → 置信度取最大的，证据拼接去重）
//   2. 其他字段：非空就覆盖（新信息比旧信息准）
//   3. 版本号 +1
//   4. 重算整体置信度
//
//   参数：
//     profile - 现有画像（旧的）
//     patch   - 这次新发现的（增量的）
//   返回值：合并后的新画像（不修改原对象，函数式编程）
// 文件路径：server/src/agents/profileSchema.ts → applyPatch()
export function applyPatch(profile: Profile, patch: ProfilePatch): Profile {
  // ① 先浅拷贝一份旧画像（...展开）作为基础
  //   为什么拷贝？函数式编程原则：不修改输入参数
  //   场景：profile 是从 DB 读出来的，不能直接改
  const next: Profile = {
    ...profile,  // 展开旧画像的所有字段
    basic: { ...profile.basic, version: profile.basic.version + 1 },  // 版本号 +1
    interests: [...profile.interests],  // 拷贝兴趣数组（后面可能修改）
    socialStyle: { ...profile.socialStyle },  // 拷贝社交风格
    // 以下是非空覆盖：patch 没提供就用旧的（?? 空值合并）
    //   patch.schedule ? [...patch.schedule] : [...profile.schedule]
    //   - patch.schedule 有值 → 用新的（拷贝一份）
    //   - patch.schedule 是 undefined → 用旧的（拷贝一份）
    //   为什么拷贝？防止后续修改影响原数组
    schedule: patch.schedule ? [...patch.schedule] : [...profile.schedule],
    goal: patch.goal ?? profile.goal,  // patch.goal 是 null/undefined → 用旧的
    //   ?? 是空值合并运算符
    //   注意：?? 只对 null/undefined 生效，对 '' 空字符串不生效
    //   所以如果 patch.goal = ''（空字符串）也会覆盖
    //   这里用 ?? 因为 LLM 返回的 goal 要么是字符串要么是 undefined
    constraints: patch.constraints ? [...patch.constraints] : [...profile.constraints],
  }

  // ② 合并兴趣：如果有新兴趣
  if (patch.interests) {
    // 遍历每个新兴趣
    for (const ni of patch.interests) {
      // 查一下：新兴趣在旧画像里有没有？（名字相同算同一个，不区分大小写）
      //   find：数组方法，返回第一个满足条件的元素，没有返回 undefined
      //   toLowerCase：转小写比较
      //   场景：旧画像有 '跑步'，新 patch 有 'RUNNING' → 不算同一个（语言不同）
      //        但旧画像有 '跑步'，新 patch 有 '跑步 '（带空格）→ 算同一个
      const existing = next.interests.find(
        i => i.name.toLowerCase() === ni.name.toLowerCase()
      )
      if (existing) {
        // 有 → 合并：置信度取最大（新证据加强已有判断）
        //   Math.min(1, Math.max(a, b))：
        //   - Math.max(a, b)：取新旧置信度的较大值
        //   - Math.min(1, ...)：上限 1（不超过 100%）
        //   场景：旧 0.6，新 0.8 → 取 0.8
        existing.confidence = Math.min(1, Math.max(existing.confidence, ni.confidence))
        // 如果有新证据且不重复，追加到 evidence 数组
        //   !existing.evidence.includes(ni.evidence)：去重
        //   includes：数组方法，检查是否包含某元素
        if (ni.evidence && !existing.evidence.includes(ni.evidence)) {
          existing.evidence.push(ni.evidence)
          // 证据最多保留 5 条，超了就删最早的
          //   shift：删数组第一个元素（最早的）
          //   场景：evidence = ['e1','e2','e3','e4','e5','e6']
          //        push 'e6' → length 6 > 5 → shift 删 'e1'
          if (existing.evidence.length > 5) existing.evidence.shift()
        }
      } else {
        // 没有 → 新增一条兴趣记录
        next.interests.push({
          name: ni.name,
          // 夹在 0-1 之间（防 LLM 返回 1.5 或 -0.3 这种异常值）
          confidence: Math.min(1, Math.max(0, ni.confidence)),
          evidence: ni.evidence ? [ni.evidence] : [],  // 有证据就放进去，没有就空数组
        })
      }
    }
  }

  // ③ 合并社交风格：提供了哪个就覆盖哪个（非空覆盖）
  //   场景：旧 socialStyle = { energy:'unknown', depth:'unknown' }
  //        patch.socialStyle = { energy:'introvert' }
  //        → next.socialStyle = { energy:'introvert', depth:'unknown' }
  if (patch.socialStyle) {
    if (patch.socialStyle.energy) next.socialStyle.energy = patch.socialStyle.energy
    if (patch.socialStyle.depth) next.socialStyle.depth = patch.socialStyle.depth
  }

  // ④ 重算整体置信度
  //   每次 patch 后都要重算，因为加了新信息置信度可能提升
  next.confidence = computeConfidence(next)
  return next
}

// ════════════════════════════════════════════════════════════
//  【核心函数 2】computeConfidence — 算画像的整体置信度
// ════════════════════════════════════════════════════════════
//   调用方：applyPatch 内部调
//   场景：小王聊了 3 轮后置信度从 0 → 0.42 → 0.72 → 0.82
//        ≥0.65 时 orchestrator 触发 PROFILE_READY 状态
//
//   加权规则：
//   - 兴趣数量和平均置信度（最大贡献，0.5 + 0.2 = 0.7）
//   - 社交风格是否明确（0.15 + 0.1 = 0.25）
//   - 目标是否明确（0.1）
//   - 时段是否明确（0.05）
//   各项累加，上限 1.0
//
//   为什么这样设计？
//   - 兴趣是核心匹配维度 → 权重最大
//   - 社交风格影响匹配质量 → 中等权重
//   - 目标/时段是辅助信息 → 小权重
// 文件路径：server/src/agents/profileSchema.ts → computeConfidence()
export function computeConfidence(p: Profile): number {
  let score = 0  // 初始分 = 0

  // ① 强兴趣贡献：每个 confidence≥0.5 的兴趣 +0.15，上限 0.5
  //   场景：3 个强兴趣 → 3 * 0.15 = 0.45（没超 0.5）
  //        4 个强兴趣 → 4 * 0.15 = 0.6 → Math.min(0.5, 0.6) = 0.5（卡在上限）
  const strongInterests = p.interests.filter(i => i.confidence >= 0.5)
  //                                ↑ filter：只保留置信度 ≥ 0.5 的兴趣
  score += Math.min(0.5, strongInterests.length * 0.15)
  //        ↑ Math.min：取小的那个，不让分数超过上限

  // ② 平均兴趣置信度贡献
  //   场景：[跑步(0.8), 爬山(0.9)] → avg = 0.85 → +0.85*0.2 = 0.17
  if (p.interests.length > 0) {
    // reduce：遍历数组，累加每个元素的 confidence
    //   参数：(累加器 s, 当前元素 i) => 新累加值，初始值
    //   场景：[跑步(0.8), 爬山(0.9)]
    //        第 1 次：s=0, i=跑步 → s + 0.8 = 0.8
    //        第 2 次：s=0.8, i=爬山 → 0.8 + 0.9 = 1.7
    //        最后 1.7 / 2 = 0.85
    const avg = p.interests.reduce((s, i) => s + i.confidence, 0) / p.interests.length
    //                              ↑ 初始值 0
    score += avg * 0.2  // 平均置信度 * 权重 0.2
  }

  // ③ 风格明确度：energy 确定了 +0.15
  if (p.socialStyle.energy !== 'unknown') score += 0.15
  //   场景：energy = 'introvert' → +0.15
  //        energy = 'unknown' → 不加分

  // ④ 深度明确度：depth 确定了 +0.1
  if (p.socialStyle.depth !== 'unknown') score += 0.1

  // ⑤ 目标明确度：有目标 +0.1
  if (p.goal) score += 0.1
  //   场景：goal = '周末爬山搭子' → +0.1
  //        goal = '' → 不加分（空字符串是 falsy）

  // ⑥ 时段明确度：有时段 +0.05
  if (p.schedule.length > 0) score += 0.05

  return Math.min(1, score)  // 上限 1（100%）
  //   Math.min(1, score)：防超 1
  //   场景：score = 1.05 → 返回 1
}

// ════════════════════════════════════════════════════════════
//  【函数 3】profileToText — 把画像转成自然语言文本
// ════════════════════════════════════════════════════════════
//   调用方：matchAgent 调 embedding 模型做向量化前
//   场景：小王的画像 → "兴趣: 跑步 爬山 社交能量: introvert 交流深度: deep 活跃时段: weekend 目标: 周末爬山搭子"
//        → 喂给 embedding 模型 → 得到向量 → 算余弦相似度找相似用户
//
//   为什么需要转文本？
//   - embedding 模型只吃文本，不吃 JSON
//   - 自然语言比 JSON 对模型更友好
//   - 拼接顺序固定保证同样画像得到同样向量
// 文件路径：server/src/agents/profileSchema.ts → profileToText()
export function profileToText(p: Profile): string {
  const parts: string[] = []  // 文本片段数组

  // 每个非空字段拼一段文本
  //   场景：p.interests = [{name:'跑步'}, {name:'爬山'}]
  //        p.interests.length = 2 → 真值 → 进入 if
  //        p.interests.map(i => i.name) → ['跑步', '爬山']
  //        .join(' ') → '跑步 爬山'
  //        '兴趣: ' + '跑步 爬山' → '兴趣: 跑步 爬山'
  if (p.interests.length)
    parts.push('兴趣: ' + p.interests.map(i => i.name).join(' '))
    //                        ↑ map：把 InterestEntry 数组转成纯名字数组
    //                        ↑ join(' ')：用空格连起来

  if (p.socialStyle.energy !== 'unknown')
    parts.push('社交能量: ' + p.socialStyle.energy)
    //   场景：energy = 'introvert' → '社交能量: introvert'

  if (p.socialStyle.depth !== 'unknown')
    parts.push('交流深度: ' + p.socialStyle.depth)

  if (p.schedule.length)
    parts.push('活跃时段: ' + p.schedule.join(' '))
    //   场景：['evening', 'weekend'] → '活跃时段: evening weekend'

  if (p.goal)
    parts.push('目标: ' + p.goal)

  if (p.constraints.length)
    parts.push('限制: ' + p.constraints.join(' '))

  return parts.join(' ')  // 用空格把所有片段连起来
  //   场景：['兴趣: 跑步 爬山', '社交能量: introvert'] → '兴趣: 跑步 爬山 社交能量: introvert'
}
