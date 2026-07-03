// ============================================================
// memoryTypes.ts — 四层分层记忆 + 统一记忆总线 类型契约
// 文件路径：server/src/memory/memoryTypes.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件定义"四层分层记忆 + 统一记忆总线"的全部数据结构。  ║
// ║                                                            ║
// ║  ▼▼▼ 为什么要四层？ ▼▼▼                                     ║
// ║    - 不同 Agent 关心的信息生命周期不同                      ║
// ║    - ProfileAgent 关心"当前会话在聊啥"（短，会话结束沉淀）  ║
// ║    - MatchAgent 关心"用户长期画像"（长，跨会话）           ║
// ║    - IceBreakerAgent 关心"以前用过啥破冰话术"（中，可复用）║
// ║    - 分层 = 按生命周期 + 访问权限隔离，避免互相干扰        ║
// ║                                                            ║
// ║  ▼▼▼ 为什么要有"统一记忆总线"？ ▼▼▼                          ║
// ║    - 4 层记忆各自有读写接口，调用方要记 4 套 API            ║
// ║    - MemoryBus 统一封装，调用方只调 bus.read/write          ║
// ║    - Bus 内部按 layer 路由到对应层                          ║
// ║    - Bus 还能做权限控制（ProfileAgent 不能写 MatchMemory） ║
// ║                                                            ║
// ║  ▼▼▼ 4 层记忆的分工 ▼▼▼                                     ║
// ║                                                            ║
// ║  Layer 1: 短期会话记忆（ShortTermMemory）                  ║
// ║    读写者：ProfileAgent 专用                               ║
// ║    存：当前会话原文 + 临时抽取信息                          ║
// ║    生命周期：会话内（滑动窗口），会话结束沉淀到 Layer 2     ║
// ║    场景：小王这轮说"想跑步"，下轮说"夜跑"，                 ║
// ║          Layer 1 保留这两轮原文，让 AI 记住上下文          ║
// ║                                                            ║
// ║  Layer 2: 长期画像记忆（LongTermProfileMemory）【核心】    ║
// ║    读写者：ProfileAgent 写入，全 Agent 共享读              ║
// ║    存：结构化标签（属性/兴趣/社交/雷区，带置信度+溯源）     ║
// ║        + 语义向量（用于相似度匹配）                        ║
// ║    生命周期：永久（跨会话，增量更新）                      ║
// ║    场景：小王 1 月前说"喜欢跑步"，今天说"喜欢夜跑"，        ║
// ║          Layer 2 增量合并：兴趣=跑步(0.9)+夜跑偏好(0.8)    ║
// ║                                                            ║
// ║  Layer 3: 匹配决策记忆（MatchDecisionMemory）              ║
// ║    读写者：MatchAgent 读写                                 ║
// ║    存：匹配对、维度得分、标签溯源、用户反馈                ║
// ║    生命周期：永久（用于去重推荐、权重迭代）                ║
// ║    场景：MatchAgent 给小王推过小李（得分 0.78），            ║
// ║          小王没兴趣（反馈=-1），下次推时降权                ║
// ║                                                            ║
// ║  Layer 4: 撮合交互记忆（InteractionMemory）                ║
// ║    读写者：IceBreakerAgent 读写                            ║
// ║    存：破冰话术历史、已用话题、交互效果                    ║
// ║    生命周期：永久（避免重复话题，优化破冰策略）            ║
// ║    场景：IceBreakerAgent 上次给小王小李用了"跑步"话题，     ║
// ║          这次推小王小张时避开"跑步"（避免重复）            ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   所有 Agent 通过 MemoryBus 读写记忆：
//
//   ProfileAgent → bus.write(Layer1, 当前对话) + bus.write(Layer2, 画像patch)
//   MatchAgent   → bus.read(Layer2, 候选画像) + bus.write(Layer3, 匹配决策)
//   IceBreakerAgent → bus.read(Layer4, 历史话术) + bus.write(Layer4, 新话术)
//
//   ┌─────────────────────────────────────────────────────┐
//   │           MemoryBus（统一记忆总线）                  │
//   │  read(layer, query) / write(layer, entry)           │
//   │  内部路由 + 权限控制 + 跨进程持久化（Redis）         │
//   └────────┬─────────┬──────────┬──────────┬────────────┘
//            │         │          │          │
//            ▼         ▼          ▼          ▼
//       Layer 1    Layer 2     Layer 3    Layer 4
//       短期会话   长期画像    匹配决策    撮合交互
//       (滑动窗口) (标签+向量) (匹配对)   (话术历史)
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - memory/memoryBus.ts（用 MemoryLayer, MemoryEntry 等）
//   - memory/shortTermMemory.ts / longTermProfileMemory.ts / ...
//   - integrations/agentMemoryAdapter.ts（包装 Agent 调 bus）
//
//   它调用：无（纯类型定义）
// ============================================================

import type { ChatMessage } from '../services/llmClient.js'
import type { MbtiProfile } from '../mbti/mbtiTypes.js'

// ════════════════════════════════════════════════════════════
//  【类型 1】MemoryLayer — 4 个记忆层的标识
// ════════════════════════════════════════════════════════════
export type MemoryLayer = 'short_term' | 'long_term_profile' | 'match_decision' | 'interaction'
//   short_term：短期会话记忆（Layer 1）
//   long_term_profile：长期画像记忆（Layer 2，核心）
//   match_decision：匹配决策记忆（Layer 3）
//   interaction：撮合交互记忆（Layer 4）

// ════════════════════════════════════════════════════════════
//  【类型 2】AgentId — 3 个 Agent 的标识（用于权限控制）
// ════════════════════════════════════════════════════════════
export type AgentId = 'profile' | 'match' | 'icebreaker'
//   profile：画像采集 Agent（写 Layer 1/2，读 Layer 2）
//   match：匹配决策 Agent（读 Layer 2，写 Layer 3）
//   icebreaker：撮合辅助 Agent（读 Layer 2/4，写 Layer 4）

// ════════════════════════════════════════════════════════════
//  【类型 3】MemoryEntry — 通用记忆条目（所有层共用基类）
// ════════════════════════════════════════════════════════════
export interface MemoryEntry {
  /** 条目唯一 ID（自动生成） */
  id: string
  /** 所属层 */
  layer: MemoryLayer
  /** 所属用户 ID */
  userId: string
  /** 写入的 Agent ID */
  writerAgent: AgentId
  /** 写入时间戳 */
  timestamp: number
  /** 条目数据（具体结构由各层定义） */
  payload: unknown
  /** 对话溯源（来自哪条用户消息，便于审计） */
  source?: {
    messageId?: string
    dialogSnippet?: string   // 原话片段（≤30字）
  }
}

// ════════════════════════════════════════════════════════════
//  【类型 4】MemoryQuery — 查询条件
// ════════════════════════════════════════════════════════════
export interface MemoryQuery {
  userId: string
  /** 限制最近 N 条（默认全部） */
  limit?: number
  /** 起始时间戳（默认 0，全部历史） */
  since?: number
  /** 关键词过滤（payload 里包含这些词的才返回） */
  keywords?: string[]
}

// ════════════════════════════════════════════════════════════
//  【类型 5】ShortTermEntry — Layer 1 短期会话记忆条目
// ════════════════════════════════════════════════════════════
export interface ShortTermEntry extends MemoryEntry {
  layer: 'short_term'
  payload: {
    /** 会话 ID */
    sessionId: string
    /** 原始对话消息 */
    messages: ChatMessage[]
    /** 临时抽取的画像信息（还没沉淀到 Layer 2 的） */
    tempPatch?: Record<string, unknown>
  }
}

// ════════════════════════════════════════════════════════════
//  【类型 6】ProfileTag — Layer 2 结构化标签（属性/兴趣/社交/雷区）
// ════════════════════════════════════════════════════════════
export interface ProfileTag {
  /** 标签类别 */
  category: 'attribute' | 'interest' | 'social' | 'redline' | 'mbti'
  //   attribute：属性（年龄/性别/职业/城市...）
  //   interest：兴趣（跑步/读书/电影...）
  //   social：社交风格（外向/内向/独处/聚会...）
  //   redline：雷区（讨厌话题/避免行为...）
  //   mbti：MBTI 类型（来自 mbti/ 模块）
  /** 标签名（如 "跑步"、"INFJ"、"30岁"） */
  name: string
  /** 标签值（如 "喜欢"、"每周3次"） */
  value?: string
  /** 置信度 0-1（越高越可信） */
  confidence: number
  /** 对话溯源（来自哪条消息抽出来的） */
  evidence: string[]
  /** 最后更新时间 */
  updatedAt: number
}

// ════════════════════════════════════════════════════════════
//  【类型 7】LongTermProfileEntry — Layer 2 长期画像记忆条目
// ════════════════════════════════════════════════════════════
export interface LongTermProfileEntry extends MemoryEntry {
  layer: 'long_term_profile'
  payload: {
    /** 结构化标签集（双存储之一） */
    tags: ProfileTag[]
    /** 语义向量（双存储之二，来自 embedding 服务） */
    vector?: number[]
    /** MBTI 画像（来自 mbti/ 模块） */
    mbti?: MbtiProfile
    /** 整体置信度（4 维平均） */
    overallConfidence: number
    /** 版本号（每次增量更新+1） */
    version: number
  }
}

// ════════════════════════════════════════════════════════════
//  【类型 8】MatchDecisionEntry — Layer 3 匹配决策记忆条目
// ════════════════════════════════════════════════════════════
export interface MatchDecisionEntry extends MemoryEntry {
  layer: 'match_decision'
  payload: {
    /** 候选用户 ID */
    candidateId: string
    /** 综合得分 0-1 */
    overallScore: number
    /** 5+1 维因子得分明细 */
    dimensionScores: {
      vector?: number       // 向量相似度
      interest?: number     // 兴趣重合
      style?: number        // 沟通风格
      schedule?: number     // 时段匹配
      goal?: number         // 目标一致
      mbti?: number         // MBTI 兼容（第 6 维）
    }
    /** 标签溯源（哪些标签贡献了得分） */
    tagTrace: { tag: string; contribution: number }[]
    /** 用户反馈（1=感兴趣, 0=中立, -1=不感兴趣, undefined=未反馈） */
    userFeedback?: 1 | 0 | -1
    /** 推荐时间 */
    recommendedAt: number
  }
}

// ════════════════════════════════════════════════════════════
//  【类型 9】InteractionEntry — Layer 4 撮合交互记忆条目
// ════════════════════════════════════════════════════════════
export interface InteractionEntry extends MemoryEntry {
  layer: 'interaction'
  payload: {
    /** 对方用户 ID */
    peerId: string
    /** 破冰话术类型（如"兴趣开场"、"情境问句"） */
    iceBreakerType: string
    /** 实际使用的话术文本 */
    iceBreakerText: string
    /** 用过的话题（避免重复） */
    topicsUsed: string[]
    /** 交互效果（1=回应积极, 0=回应平淡, -1=无回应） */
    effect: 1 | 0 | -1
    /** 交互时间 */
    interactedAt: number
  }
}

// ════════════════════════════════════════════════════════════
//  【类型 10】MemoryAccessPermission — 权限矩阵
// ════════════════════════════════════════════════════════════
//   每个 Agent 对每层的权限：'read' / 'write' / 'readwrite' / 'none'
export type MemoryPermission = 'read' | 'write' | 'readwrite' | 'none'

// 权限矩阵常量（启动时初始化 MemoryBus 用）
//   行=Agent，列=Layer
export const MEMORY_PERMISSIONS: Record<AgentId, Record<MemoryLayer, MemoryPermission>> = {
  // ProfileAgent：写短期+长期画像，读长期画像
  profile: {
    short_term: 'write',           // 写当前会话原文
    long_term_profile: 'readwrite',// 写画像 patch + 读已有画像
    match_decision: 'none',        // 不关心匹配决策
    interaction: 'none',           // 不关心破冰话术
  },
  // MatchAgent：读长期画像，写匹配决策
  match: {
    short_term: 'none',            // 不关心当前会话
    long_term_profile: 'read',     // 读用户和候选画像
    match_decision: 'readwrite',   // 写新匹配 + 读历史匹配（去重）
    interaction: 'read',           // 读历史破冰（避免重复推荐）
  },
  // IceBreakerAgent：读画像+交互历史，写新交互
  icebreaker: {
    short_term: 'none',
    long_term_profile: 'read',     // 读双方画像找共同点
    match_decision: 'read',        // 读匹配得分找切入点
    interaction: 'readwrite',      // 写新破冰 + 读历史（避免重复）
  },
} as const

// ════════════════════════════════════════════════════════════
//  【常量 1】MEMORY_CONFIG — 记忆模块参数
// ════════════════════════════════════════════════════════════
export const MEMORY_CONFIG = {
  /** Layer 1 短期记忆滑动窗口大小（最多保留几条消息） */
  shortTermWindowSize: 20,
  /** Layer 2 长期画像的标签置信度阈值（低于此值不写进长期） */
  longTermConfidenceThreshold: 0.5,
  /** Layer 3 匹配决策去重窗口（最近 N 次推荐过的候选不再推） */
  matchDedupWindow: 20,
  /** Layer 4 破冰话题去重窗口（最近 N 次用过的话题不再用） */
  interactionTopicDedup: 10,
} as const
