// ============================================================
// mbtiTypes.ts — MBTI 类型契约（"底层结合 MBTI 去算填"的数据根基）
// 文件路径：server/src/mbti/mbtiTypes.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是整个 MBTI 子系统的"数据身份证"。                  ║
// ║  MBTI 是个老牌人格模型，4 维度 × 2 极 = 16 种类型，          ║
// ║  每种类型有固定的 8 个认知功能（cognitive functions）顺序。   ║
// ║                                                            ║
// ║  为啥要在搭子系统里用 MBTI？                                 ║
// ║  - 已有的 5 维因子（向量/兴趣/风格/时段/目标）只看"显性行为"  ║
// ║  - MBTI 看"信息加工方式"——两个人都喜欢跑步，                ║
// ║    但一个是 INFJ（内省型）一个是 ESTP（行动派），             ║
// ║    搭子体验天差地别                                          ║
// ║  - 加 MBTI 当第 6 维，匹配的"深度合拍"提升一截              ║
// ║                                                            ║
// ║  核心原则（和 Dazi 已有设计保持一致）：                      ║
// ║  - 不让用户填表！从对话里偷偷抽 MBTI 信号                    ║
// ║  - 置信度驱动（一开始 unknown，越聊越明确）                  ║
// ║  - 双模式（LLM 抽 + 关键词兜底），保证可用                    ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王聊了 10 句话后，MBTI 抽取出来的样子 ▼▼▼
//
//   小王："我喜欢一个人安静地看书思考人生意义"
//         "讨厌表面寒暄，喜欢深入交流"
//         "做决定前总要反复权衡"
//        │
//        ▼
//   mbtiExtractor 从这些话里抽出 4 个维度信号：
//     E/I → I（introvert，安静独处）confidence=0.8
//     S/N → N（intuition，思考意义/讨厌表面）confidence=0.7
//     T/F → F（feeling，深入交流/人际）confidence=0.5（弱）
//     J/P → J（judging，反复权衡）confidence=0.6
//        │
//        ▼
//   mbtiEngine 把 4 维信号合成类型 → 'INFJ'
//   顺带推出认知功能栈：Ni > Fe > Ti > Se（INFJ 的标准栈）
//        │
//        ▼
//   mbtiCompat 算小王（INFJ）和候选小李（ENFP）的合拍度：
//     - 功能栈互补：INFJ 的 Ni 主导 + ENFP 的 Ne 主导 → 0.85
//     - 维度差异适中（4 维都不极端对立）→ 0.75
//     - 综合 MBTI 兼容分 = 0.82
//   MatchAgent 拿这个分当第 6 维因子加权进总分
//
// ════════════════════════════════════════════════════════════
//  【MBTI 速成（够看懂下面的代码就行）】
// ════════════════════════════════════════════════════════════
//   4 个维度，每维度 2 极：
//     E/I  外向/内向     能量来源：人/独处
//     S/N  实感/直觉     信息收集：具体/抽象
//     T/F  思考/情感     决策方式：逻辑/价值
//     J/P  判断/感知     生活方式：计划/灵活
//
//   16 种类型 = 2^4 组合：INTJ / INTP / ENTJ / ENTP / ...
//
//   每种类型有 4 个"主要认知功能"（功能栈）：
//     主导 → 辅助 → 第三 → 劣势
//   例：INTJ = Ni(主导) → Te(辅助) → Fi(第三) → Se(劣势)
//
//   8 个认知功能：
//     Se 外倾实感  Si 内倾实感
//     Ne 外倾直觉  Ni 内倾直觉
//     Te 外倾思考  Ti 内倾思考
//     Fe 外倾情感  Fi 内倾情感
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   用户聊天 → ProfileAgent 抽画像 patch（已有）
//                    │
//                    ▼ （新增 hook，零侵入）
//              mbtiExtractor.extract(messages) → MbtiProfile
//                    │
//                    ▼
//              存进长期画像记忆（memory/ 模块）
//                    │
//                    ▼
//   MatchAgent 匹配时（已有 5 维）→ mbtiCompat.score(my, theirs)
//                    │
//                    ▼
//   综合分 = 0.4*原5维 + 0.1*mbtiCompat + 0.5*vector（权重可调）
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - mbtiEngine.ts（用这里的类型合成类型/功能栈）
//   - mbtiCompat.ts（用功能栈算兼容度）
//   - mbtiExtractor.ts（产出 MbtiProfile）
//   - integrations/matchAgentMbtiAdapter.ts（把 MBTI 分挂进 MatchAgent）
//   - memory/longTermProfileMemory.ts（MbtiProfile 是画像的一部分）
//
//   它调用：无（纯类型定义，零依赖）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - export type A = 'a' | 'b'  → 联合字面量类型（写错立刻报错）
//   - as const → 让 TS 把字面量数组当元组类型（不会退化成 string[]）
//   - Record<K, V> → 以 K 为 key、V 为 value 的字典类型
//   - readonly → 只读，防止运行时被偷偷改（MBTI 映射表必须不可变）
// ============================================================

// ════════════════════════════════════════════════════════════
//  【类型 1】MbtiDimension — 4 个维度的"维度名"
// ════════════════════════════════════════════════════════════
//   联合字面量类型：只能是这 4 个字符串之一，写错（如 'E/I'）立刻报错
//   好处：IDE 自动补全 + 拼错编译失败
// 文件路径：server/src/mbti/mbtiTypes.ts
export type MbtiDimension = 'EI' | 'SN' | 'TF' | 'JP'
//   EI：外向(E) / 内向(I)   能量从哪来——人多热闹 vs 独处安静
//   SN：实感(S) / 直觉(N)   收集信息的方式——具体细节 vs 抽象意义
//   TF：思考(T) / 情感(F)   做决定的方式——逻辑对错 vs 价值感受
//   JP：判断(J) / 感知(P)   对待外部世界的态度——计划秩序 vs 灵活开放

// ════════════════════════════════════════════════════════════
//  【类型 2】MbtiPole — 每个维度的"两极字母"
// ════════════════════════════════════════════════════════════
//   8 个极字母，组合成 16 种类型
// 文件路径：server/src/mbti/mbtiTypes.ts
export type MbtiPole = 'E' | 'I' | 'S' | 'N' | 'T' | 'F' | 'J' | 'P'
//   E (Extraversion)  外向 — 能量来自外界人际互动
//   I (Introversion)  内向 — 能量来自独处内省
//   S (Sensing)       实感 — 关注具体细节、五官感知、经验事实
//   N (iNtuition)     直觉 — 关注模式意义、可能性、未来想象
//   T (Thinking)      思考 — 用逻辑因果做决定
//   F (Feeling)       情感 — 用价值感受做决定
//   J (Judging)       判断 — 喜欢计划、秩序、收尾
//   P (Perceiving)    感知 — 喜欢灵活、开放、保留选择

// ════════════════════════════════════════════════════════════
//  【类型 3】MbtiType — 16 种类型字面量
// ════════════════════════════════════════════════════════════
//   每个类型由 4 个极字母组合而成
//   写成联合字面量类型而非 `string`，是为了：
//   - 编译期就能抓住 'IXTJ' 这种笔误
//   - 函数参数标注 MbtiType 时，IDE 提示所有合法值
// 文件路径：server/src/mbti/mbtiTypes.ts
export type MbtiType =
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'

// ════════════════════════════════════════════════════════════
//  【类型 4】CognitiveFunction — 8 个认知功能
// ════════════════════════════════════════════════════════════
//   MBTI 理论的"内功"——比 4 字母更精细
//   每个类型有 4 个主要功能按固定顺序排（功能栈）
//   例：INTJ 的功能栈是 Ni(主导) → Te(辅助) → Fi(第三) → Se(劣势)
// 文件路径：server/src/mbti/mbtiTypes.ts
export type CognitiveFunction = 'Se' | 'Si' | 'Ne' | 'Ni' | 'Te' | 'Ti' | 'Fe' | 'Fi'
//   Se 外倾实感：当下体验、行动、感官刺激（ESTP/ESFP 主导）
//   Si 内倾实感：经验、记忆、稳定、细节（ISTJ/ISFJ 主导）
//   Ne 外倾直觉：发散、可能、头脑风暴（ENTP/ENFP 主导）
//   Ni 内倾直觉：收敛、洞察、长远视角（INTJ/INFJ 主导）
//   Te 外倾思考：组织、执行、效率（ENTJ/ESTJ 主导）
//   Ti 内倾思考：分析、原理、精确（INTP/ISTP 主导）
//   Fe 外倾情感：群体和谐、他人感受（ENFJ/ESFJ 主导）
//   Fi 内倾情感：内在价值、真诚、个人信念（INFP/ISFP 主导）

// ════════════════════════════════════════════════════════════
//  【类型 5】FunctionStack — 一个类型的功能栈（4 个功能有序排列）
// ════════════════════════════════════════════════════════════
//   [主导, 辅助, 第三, 劣势]
//   元组类型 [A, B, C, D] 比数组类型 A[] 更严格——长度和顺序都固定
// 文件路径：server/src/mbti/mbtiTypes.ts
export type FunctionStack = readonly [CognitiveFunction, CognitiveFunction, CognitiveFunction, CognitiveFunction]
//   readonly：功能栈定义后不可变（MBTI 理论是固定的，不该被运行时改）

// ════════════════════════════════════════════════════════════
//  【类型 6】MbtiDimensionSignal — 单个维度的抽取信号
// ════════════════════════════════════════════════════════════
//   抽取器产出这种结构，引擎拿它合成最终类型
//   设计要点：每维度独立打分 + 置信度，避免"4 维同时低置信度还硬出类型"
// 文件路径：server/src/mbti/mbtiTypes.ts
export interface MbtiDimensionSignal {
  dimension: MbtiDimension      // 哪个维度（'EI' / 'SN' / 'TF' / 'JP'）
  pole: MbtiPole                // 倾向哪一极（'E' / 'I' / ...）
  confidence: number            // 置信度 0-1（0.5 以下算"测不准"）
  evidence: string[]            // 证据（用户原话片段，最多 5 条）
}
//   场景：抽取器从小王"喜欢一个人安静看书"抽出
//     { dimension:'EI', pole:'I', confidence:0.8, evidence:['喜欢一个人安静看书'] }

// ════════════════════════════════════════════════════════════
//  【类型 7】MbtiProfile — 一个用户的完整 MBTI 画像
// ════════════════════════════════════════════════════════════
//   这是 MBTI 模块对外的主打数据结构
//   存进长期画像记忆（memory/longTermProfileMemory.ts）
//   MatchAgent 匹配时读出来算兼容度
// 文件路径：server/src/mbti/mbtiTypes.ts
export interface MbtiProfile {
  type: MbtiType | 'UNKNOWN'    // 类型（一开始 'UNKNOWN'，越聊越明确）
  confidence: number            // 整体置信度 0-1（4 维置信度的综合）
  dimensions: MbtiDimensionSignal[]  // 4 维信号（即使 type 已定也保留，便于增量更新）
  functionStack?: FunctionStack // 认知功能栈（type 确定后由引擎派生）
  updatedAt: number             // 最后更新时间（毫秒戳）
}
//   场景：小王聊 5 句后
//     {
//       type: 'INFJ',
//       confidence: 0.62,
//       dimensions: [
//         { dimension:'EI', pole:'I', confidence:0.8, evidence:[...] },
//         { dimension:'SN', pole:'N', confidence:0.7, evidence:[...] },
//         { dimension:'TF', pole:'F', confidence:0.5, evidence:[...] },
//         { dimension:'JP', pole:'J', confidence:0.6, evidence:[...] },
//       ],
//       functionStack: ['Ni','Fe','Ti','Se'],
//       updatedAt: 1700000000000,
//     }

// ════════════════════════════════════════════════════════════
//  【类型 8】MbtiCompatResult — 两个人的 MBTI 兼容度结果
// ════════════════════════════════════════════════════════════
//   不只给一个分数，还给"为啥合拍"的可解释文本（和 Dazi 已有的 buildExplanation 风格一致）
// 文件路径：server/src/mbti/mbtiTypes.ts
export interface MbtiCompatResult {
  score: number                 // 兼容度 0-1（越高越合拍）
  reason: string                // 可解释文本（"功能栈互补：你的 Ni 和 TA 的 Ne..."）
  detail: {
    functionComplement: number  // 功能栈互补分（0-1）
    dimensionBalance: number    // 维度平衡分（0-1，差异适中最好）
    dominantHarmony: number     // 主导功能和谐分（0-1）
  }
}
//   场景：小王 INFJ + 小李 ENFP
//     {
//       score: 0.82,
//       reason: '功能栈高度互补（Ni+Ne 黄金组合），维度差异适中',
//       detail: { functionComplement:0.85, dimensionBalance:0.75, dominantHarmony:0.86 }
//     }

// ════════════════════════════════════════════════════════════
//  【常量 1】MBTI_TYPE_STACKS — 16 类型 → 功能栈的静态映射表
// ════════════════════════════════════════════════════════════
//   MBTI 理论固定不变，做成 readonly 查表，O(1) 拿功能栈
//   顺序：[主导, 辅助, 第三, 劣势]
//   规律：
//   - 主导功能决定了类型的"内核"（如 INTJ 的 Ni = 洞察长远）
//   - 主导与辅助一内一外（保持内外平衡）
//   - 劣势功能是主导的"阴影"，最难自觉使用
// 文件路径：server/src/mbti/mbtiTypes.ts
export const MBTI_TYPE_STACKS: Readonly<Record<MbtiType, FunctionStack>> = {
  // ── NT 理性者（直觉+思考）──
  INTJ: ['Ni', 'Te', 'Fi', 'Se'],  // 战略家：洞察+执行+价值+感官
  INTP: ['Ti', 'Ne', 'Si', 'Fe'],  // 逻辑家：分析+发散+记忆+情感
  ENTJ: ['Te', 'Ni', 'Se', 'Fi'],  // 指挥官：执行+洞察+感官+价值
  ENTP: ['Ne', 'Ti', 'Fe', 'Si'],  // 辩论家：发散+分析+情感+记忆

  // ── NF 理想主义者（直觉+情感）──
  INFJ: ['Ni', 'Fe', 'Ti', 'Se'],  // 提倡者：洞察+和谐+分析+感官
  INFP: ['Fi', 'Ne', 'Si', 'Te'],  // 调停者：价值+发散+记忆+执行
  ENFJ: ['Fe', 'Ni', 'Se', 'Ti'],  // 主人公：和谐+洞察+感官+分析
  ENFP: ['Ne', 'Fi', 'Te', 'Si'],  // 竞选者：发散+价值+执行+记忆

  // ── SJ 守护者（实感+判断）──
  ISTJ: ['Si', 'Te', 'Fi', 'Ne'],  // 物流师：记忆+执行+价值+发散
  ISFJ: ['Si', 'Fe', 'Ti', 'Ne'],  // 守卫者：记忆+和谐+分析+发散
  ESTJ: ['Te', 'Si', 'Ne', 'Fi'],  // 总经理：执行+记忆+发散+价值
  ESFJ: ['Fe', 'Si', 'Ne', 'Ti'],  // 执政官：和谐+记忆+发散+分析

  // ── SP 艺术家（实感+感知）──
  ISTP: ['Ti', 'Se', 'Ni', 'Fe'],  // 鉴赏家：分析+感官+洞察+和谐
  ISFP: ['Fi', 'Se', 'Ni', 'Te'],  // 探险家：价值+感官+洞察+执行
  ESTP: ['Se', 'Ti', 'Fe', 'Ni'],  // 企业家：感官+分析+和谐+洞察
  ESFP: ['Se', 'Fi', 'Te', 'Ni'],  // 表演者：感官+价值+执行+洞察
} as const   // as const：让 TS 把每个值当精确字面量元组，不会退化成 string[][]

// ════════════════════════════════════════════════════════════
//  【常量 2】DIMENSION_POLES — 维度 → 两极字母的映射
// ════════════════════════════════════════════════════════════
//   抽取器产出维度信号时用，避免散落字符串硬编码
// 文件路径：server/src/mbti/mbtiTypes.ts
export const DIMENSION_POLES: Readonly<Record<MbtiDimension, readonly [MbtiPole, MbtiPole]>> = {
  EI: ['E', 'I'],   // 外向 / 内向
  SN: ['S', 'N'],   // 实感 / 直觉
  TF: ['T', 'F'],   // 思考 / 情感
  JP: ['J', 'P'],   // 判断 / 感知
} as const

// ════════════════════════════════════════════════════════════
//  【常量 3】POLE_TO_DIMENSION — 反向映射：极字母 → 所属维度
// ════════════════════════════════════════════════════════════
//   引擎合成类型时用：拿到 4 个极字母拼成类型字符串
// 文件路径：server/src/mbti/mbtiTypes.ts
export const POLE_TO_DIMENSION: Readonly<Record<MbtiPole, MbtiDimension>> = {
  E: 'EI', I: 'EI',
  S: 'SN', N: 'SN',
  T: 'TF', F: 'TF',
  J: 'JP', P: 'JP',
} as const

// ════════════════════════════════════════════════════════════
//  【工具函数】createEmptyMbtiProfile — 造一个空 MBTI 画像（新用户用）
// ════════════════════════════════════════════════════════════
//   场景：用户刚注册，调这个造个空壳，后续越聊越填充
//   设计：4 维都给 'unknown' 状态（pole 用 'I' 占位但 confidence=0，表示"未测"）
// 文件路径：server/src/mbti/mbtiTypes.ts → createEmptyMbtiProfile()
export function createEmptyMbtiProfile(): MbtiProfile {
  return {
    type: 'UNKNOWN',
    confidence: 0,
    dimensions: [
      { dimension: 'EI', pole: 'I', confidence: 0, evidence: [] },
      { dimension: 'SN', pole: 'N', confidence: 0, evidence: [] },
      { dimension: 'TF', pole: 'F', confidence: 0, evidence: [] },
      { dimension: 'JP', pole: 'J', confidence: 0, evidence: [] },
    ],
    updatedAt: Date.now(),
  }
}
