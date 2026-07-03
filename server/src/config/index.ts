// ============================================================
// index.ts — 全局配置中心（从 .env 读，带默认值）
// 文件路径：server/src/config/index.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是"中央配置台"——所有"能调的东西"都在这。           ║
// ║  端口、API Key、匹配权重、阈值、限流数，全从这读。           ║
// ║  改配置只要改 .env 文件，不用动代码（运维友好）。             ║
// ║                                                            ║
// ║  核心配置分组：                                              ║
// ║  - llm: API 地址、Key、模型名（DeepSeek 配置）              ║
// ║  - embed: 向量嵌入方式（API or 本地）                       ║
// ║  - match: 召回数、返回数、5 维权重（调推荐风格的核心）       ║
// ║  - profile: 置信度阈值、发给 LLM 的历史轮数                 ║
// ║  - rateLimitPerHour: 限流（每小时最多 30 条）               ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：不同环境用不同 .env ▼▼▼
//
//   开发环境（.env）：
//     LLM_API_KEY=                    ← 空，用降级模式（不花钱）
//     DB_PATH=./data/matchmate.db
//     PORT=8787
//        │
//        ▼
//   config.llm.enabled = false       ← 没 Key 就关 LLM
//   config.embed.enabled = false      ← 没 Key 就用本地嵌入
//   ProfileAgent → 用模板抽取（不调 LLM）
//   MatchAgent → 用规则匹配（不调 LLM）
//
//   生产环境（.env.production）：
//     LLM_API_KEY=sk-xxx              ← 有 Key
//     DB_PATH=/var/data/matchmate.db
//     PORT=80
//        │
//        ▼
//   config.llm.enabled = true         ← 开 LLM
//   config.embed.enabled = true      ← 开远端嵌入
//   ProfileAgent → 用 LLM 抽取（更准）
//   MatchAgent → 用 LLM 重排（更智能）
//
// ════════════════════════════════════════════════════════════
//  【匹配权重详解（match.weights）】
// ════════════════════════════════════════════════════════════
//   vector: 0.45    ← 向量相似度（最重要，整体气质合拍）
//   interest: 0.25  ← 兴趣重合（都喜欢跑步）
//   style: 0.15     ← 社交风格（都内向慢热）
//   schedule: 0.10  ← 时段重合（都周末活跃）
//   goal: 0.05      ← 目标互补（一个找学习搭子，一个找学生）
//
//   想调推荐风格改这里：
//   - 多推兴趣相近 → 提高 interest
//   - 多推性格互补 → 降低 style
//   - 多推向量最像 → 提高 vector
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   服务启动 → import config → 全局可用
//   所有 services/agents/routes/db 都从这读配置
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：几乎所有人
//   - services/llmClient.ts: config.llm（API 配置）
//   - services/embedding.ts: config.embed（嵌入配置）
//   - services/auth.ts: config.jwtSecret（JWT 密钥）
//   - services/rateLimiter.ts: config.rateLimitPerHour（限流）
//   - db/index.ts: config.dbPath（数据库路径）
//   - agents/matchAgent.ts: config.match（匹配权重）
//   - agents/profileAgent.ts: config.profile（画像配置）
//
//   它调用：
//   - dotenv（加载 .env 文件到 process.env）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - process.env → Node 读取环境变量
//   - !!env(...) → 双重否定转布尔（空字符串 → false，非空 → true）
//   - as const → 让 TS 把字面量当精确类型（不是笼统的 number/string）
//   - typeof config → 获取 config 的类型（AppConfig）
// ============================================================

import 'dotenv/config'
//   ↑ dotenv：把 .env 文件里的 KEY=VALUE 加载到 process.env（只在开发环境有用）

// 【工具函数】读字符串环境变量，没设就用 fallback
// 文件路径：server/src/config/index.ts → env()
function env(key: string, fallback = ''): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

// 【工具函数】读整数环境变量，没设或非法就用 fallback
// 文件路径：server/src/config/index.ts → envInt()
function envInt(key: string, fallback: number): number {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : fallback
  //     ↑ 是合法的数字且 > 0 → 用；否则用默认
}

export const config = {
  port: envInt('PORT', 8787),                                              // 后端端口
  jwtSecret: env('JWT_SECRET', 'dev-only-insecure-secret-change-me'),      // JWT 签名密钥
  dbPath: env('DB_PATH', './data/matchmate.db'),                           // 数据库文件路径
  webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),                   // 前端地址（CORS 用）

  llm: {
    apiBase: env('LLM_API_BASE', 'https://api.deepseek.com'),              // API 地址
    apiKey: env('LLM_API_KEY', ''),                                        // API Key（空 = 降级模式）
    model: env('LLM_MODEL', 'deepseek-chat'),                              // 模型名
    enabled: !!env('LLM_API_KEY', ''),  // !!：有 Key = true，没 Key = false
  },

  embed: {
    apiBase: env('EMBED_API_BASE', ''),
    apiKey: env('EMBED_API_KEY', ''),
    model: env('EMBED_MODEL', ''),
    enabled: !!env('EMBED_API_KEY', ''),
    dim: 256,  // 本地嵌入的向量维度（改成 1536 可接远端 embedding）
  },

  rateLimitPerHour: envInt('RATE_LIMIT_PER_HOUR', 30),                    // 每小时限流 N 条
  conversationRetentionDays: envInt('CONVERSATION_RETENTION_DAYS', 30),  // 对话保留天数

  // ─── 匹配引擎配置（改这里就能调推荐风格）───
  match: {
    topK: 20,            // 向量召回取前多少候选
    finalN: 5,           // 最终返回几个候选给用户
    weights: {           // 6 维因子的权重（加起来 = 1.0，归一化在 weightedScore 内）
      vector: 0.35,      // 向量相似度权重（最重要，整体气质合拍）
      interest: 0.20,    // 兴趣重合权重
      style: 0.15,       // 社交风格匹配权重
      schedule: 0.10,    // 时段重合权重
      goal: 0.05,        // 目标互补权重（最轻）
      mbti: 0.15,        // MBTI 兼容度权重（思维方式互补，第 6 维）
    },
    minConfidence: 0.4,  // 画像字段置信度 < 0.4 不参与匹配加权
  },

  // ─── 画像采集配置 ───
  profile: {
    matchTriggerConfidence: 0.65,  // 置信度 ≥ 0.65 自动触发匹配
    maxRoundsKept: 20,             // 画像抽取时发给 LLM 的最近对话轮数
  },
} as const  // as const：TS 把每个值当精确字面量类型，不会推断成笼统的 number/string

export type AppConfig = typeof config
//     ↑ type 别名：等于 "config 对象的完整类型"，别的地方可以用 AppConfig 标注
