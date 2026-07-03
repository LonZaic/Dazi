// ============================================================
// embedding.ts — 向量嵌入服务（把文本变成"指纹"数字数组）
// 文件路径：server/src/services/embedding.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是"画像指纹机"——把一段文字（如"兴趣: 跑步 爬山"）   ║
// ║  变成一个 256 维的数字数组。两个画像的向量越像 → 余弦相似度   ║
// ║  越高 → 两个人越合拍。                                       ║
// ║                                                            ║
// ║  核心用途：MatchAgent 召回时算"谁和我最像"                    ║
// ║  没向量 = 没法做向量召回 = 匹配引擎失效                       ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王画像更新后，embedding 干了啥 ▼▼▼
//
//   小王聊了 5 轮，画像置信度从 0.3 升到 0.72
//        │
//        ▼
//   profileAgent.execute() → 画像更新了
//        │
//        ▼
//   const text = profileToText(profile)
//   → "兴趣: 跑步 爬山 社交能量: introvert 活跃时段: weekend 目标: 周末爬山搭子"
//        │
//        ▼
//   const vec = await embed(text)   ← 调这个文件
//        │
//        ├── 配了 EMBED_API_KEY → embedViaApi(text)
//        │   POST /embeddings → 返回 1536 维高质量向量
//        │
//        └── 没配 Key → embedLocal(text)
//            ① 中文字符 bigram："兴趣跑步" → ["兴趣","趣跑","跑步"]
//            ② 英文词 trigram："running" → ["run","unn","nni","nin","ing"]
//            ③ 每个 token 哈希到 256 维桶，桶值 +1
//            ④ L2 归一化（向量长度变 1，便于算余弦）
//            → 返回 [0.12, 0, 0.45, 0, 0.08, ...] (256 个数)
//        │
//        ▼
//   updateProfileEmbedding(userId, vec) → 存进 profiles.embedding 字段
//   MatchAgent 召回时：recallByVector(myVec) → 和所有人的向量比余弦
//
// ════════════════════════════════════════════════════════════
//  【双模式设计】
// ════════════════════════════════════════════════════════════
//   1. API 模式（高质量）：配 EMBED_API_KEY → 调远端模型（1536 维）
//      - 准确度高，但花钱+依赖网络
//   2. 本地模式（零依赖）：没配 Key → 用哈希+bigram（256 维）
//      - 准确度低，但免费+离线可跑
//
//   本地嵌入原理（bigram + 哈希）：
//     "我喜欢跑步" → 中文字符 bigram → ["我喜","喜欢","欢跑","跑步"]
//     每个 bigram 哈希到 0-255 的桶号，桶值 += 1
//     最后 L2 归一化（让向量长度=1，余弦相似度=点积）
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   ProfileAgent → embed() → 存向量
//   MatchAgent → recallByVector() → 读向量 + 算余弦
//   scripts/seed.ts → embedLocal() → 种子数据预置向量
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - profileAgent.ts: embed()（画像更新时算向量）
//   - scripts/seed.ts: embedLocal()（种子数据预置向量）
//
//   它调用：
//   - ../config/index.js → config.embed（读 API 地址/Key/维度）
//   - 全局 fetch（API 模式用）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - Float64Array → 浮点数组（比普通 Array 快）
//   - Array.from(vec) → 把 Float64Array 转普通数组
//   - Math.imul → 32 位整数乘法（快，防溢出）
//   - >>> 0 → 无符号右移 0 位（把结果变成无符号 32 位整数）
// ============================================================

import { config } from '../config/index.js'

const DIM = config.embed.dim  // 向量维度（默认 256）

// 【函数】本地嵌入 — 不调 API，纯计算
// 文件路径：server/src/services/embedding.ts → embedLocal()
export function embedLocal(text: string): number[] {
  const vec = new Float64Array(DIM)  // 256 个 0 的数组
  if (!text) return Array.from(vec)  // 空文本 → 全 0 向量

  const tokens: string[] = []  // 分词结果

  // ① 中文字符 bigram：每相邻两个字符组成一对
  //    如 "我喜欢" → ["我喜", "喜欢"]
  const cjk = text.match(/[\u4e00-\u9fa5]/g) || []  // 提取所有中文字符
  for (let i = 0; i < cjk.length - 1; i++)
    tokens.push(cjk[i]! + cjk[i + 1]!)  // ! 是非空断言：cjk[i] 不是 undefined
  // 也加单字符（捕捉单个字的语义）
  for (const c of cjk) tokens.push(c)

  // ② 英文/数字词切分
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || []
  for (const w of words) {
    tokens.push(w)
    // 长词加 trigram（3 字符片段，如 "running" → "run","unn","nni","nin","ing"）
    if (w.length > 3)
      for (let i = 0; i < w.length - 2; i++)
        tokens.push(w.slice(i, i + 3))
  }

  // ③ 每个 token 哈希到 DIM 维桶里，桶值 +1
  for (const tok of tokens) {
    const h = hash(tok) % DIM  // 哈希值 % 256 → 落到 0-255 的桶
    vec[h] += 1
  }

  // ④ L2 归一化（让向量长度为 1，便于余弦相似度直接点积）
  let norm = 0
  for (let i = 0; i < DIM; i++) norm += vec[i]! * vec[i]!
  norm = Math.sqrt(norm)  // 平方和开根号 = 向量长度
  if (norm > 0)
    for (let i = 0; i < DIM; i++) vec[i] /= norm  // 每个分量除以长度 → 长度变成 1

  return Array.from(vec)  // Float64Array → 普通数组
}

// 【函数】FNV-1a 哈希（简单、快、均匀分布）
// 文件路径：server/src/services/embedding.ts → hash()
function hash(s: string): number {
  let h = 2166136261  // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)            // XOR 当前字符的 Unicode 码
    h = Math.imul(h, 16777619)     // 乘以 FNV prime（imul = 32 位整数乘法，快）
  }
  return h >>> 0  // 转无符号 32 位整数（去掉符号位）
}

// 【函数】主入口：优先 API，降级本地
// 文件路径：server/src/services/embedding.ts → embed()
export async function embed(text: string): Promise<number[]> {
  if (config.embed.enabled && config.embed.apiBase) {
    try {
      return await embedViaApi(text)  // 有 API Key → 调远端（更准）
    } catch {
      return embedLocal(text)         // 挂了 → 降级本地
    }
  }
  return embedLocal(text)  // 没配 Key → 直接本地
}

// 【函数】调远端 Embedding API
// 文件路径：server/src/services/embedding.ts → embedViaApi()
async function embedViaApi(text: string): Promise<number[]> {
  const url = `${config.embed.apiBase.replace(/\/$/, '')}/embeddings`
  //                           ↑ replace(/\/$/, '')：去掉末尾的 /（防拼接成 //）
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.embed.apiKey}`,
    },
    body: JSON.stringify({ model: config.embed.model, input: text }),
  })
  if (!resp.ok) throw new Error(`embed API ${resp.status}`)
  const json: any = await resp.json()
  return json.data?.[0]?.embedding || embedLocal(text)
  //     ↑ 取第一个结果的 embedding 数组，取不到降级本地
}
