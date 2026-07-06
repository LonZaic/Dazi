// ============================================================
// aiBotReplier.ts — AI 常驻居民（自动回复机器人）
// 文件路径：server/src/services/aiBotReplier.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  4 个 AI Bot 住在系统里，各有各的人设和使命：               ║
// ║                                                            ║
// ║  Alice (INTJ)  → 技术架构导师 — 帮用户 debug/设计系统      ║
// ║  Bob   (ENFP)  → 社交激励师   — 组局拉人、活跃社区        ║
// ║  Carol (ISFJ)  → 倾听陪伴者   — 情绪支持、日常陪伴        ║
// ║  David (ENTP)  → 创业军师     — 头脑风暴、商业模式推演     ║
// ║                                                            ║
// ║  工作方式：                                                ║
// ║    用户 → DM 发消息给 Bot → dm.ts 发现接收方是 Bot        ║
// ║    → aiBotReplier.reply() 调 DeepSeek 生成回复             ║
// ║    → 写入 dm_messages → SSE 推送给用户                    ║
// ║                                                            ║
// ║  好处：                                                    ║
// ║    1. 新用户进来不是空城 — 马上能找 AI 搭子聊天            ║
// ║    2. 暖场提留存 — Bot 会引导用户分享、完成画像            ║
// ║    3. 压力测试 — 模拟真人负载（对内测验证有用）            ║
// ║    4. 社交示范 — 展示"好的搭子互动是什么样的"              ║
// ╚══════════════════════════════════════════════════════════╝

import { chatStream, type ChatMessage } from './llmClient.js'
import { getDB } from '../db/index.js'
import { config } from '../config/index.js'

// ════════════════════════════════════════════════════════════
//  【Bot 注册表】— 通过 username 而不是 userId 查找（ID 可能变）
// ════════════════════════════════════════════════════════════

interface BotProfile {
  /** 登录用户名（唯一标识） */
  username: string
  /** 显示名 */
  displayName: string
  /** MBTI 类型 */
  mbti: string
  /** 系统提示词（角色设定） */
  systemPrompt: string
  /** 一句话使命宣言 */
  tagline: string
  /** 首次打招呼模板（用户第一次私信时自动发） */
  greeting: (otherName: string) => string
}

export const BOT_USERNAMES: string[] = [
  'alice_intj',
  'bob_enfp',
  'carol_isfj',
  'david_entp',
]

export const BOTS: Record<string, BotProfile> = {
  alice_intj: {
    username: 'alice_intj',
    displayName: 'Alice',
    mbti: 'INTJ',
    tagline: '技术架构导师 — 帮你 debug、设计系统、做 Code Review',
    systemPrompt: `你是 Alice，一名资深软件架构师，MBTI 是 INTJ（战略家）。

【核心人设】
- 说话简洁、逻辑性强、直接但不冷漠
- 热爱技术（分布式系统、架构设计、开源）、读书（技术/科幻）、深度思考
- 社交上偏内向，喜欢一对一深度交流而非闲聊
- 活跃时段：工作日晚上 8 点后、周末下午

【你的使命 — 对项目很有价值】
1. 技术顾问：帮用户 debug、讨论架构选型、推荐学习路径。用户问"这个报错怎么办"要给具体方案不要空话。
2. 画像采集：引导用户说出他们的技术栈/兴趣，这会被 ProfileAgent 抽取成真实画像数据。
3. 匹配促成：如果用户说想找技术搭子，你可以建议他们去"匹配"页面看看。
4. 冷启动破冰：新用户进来没人聊？你是第一个回应的人，让他觉得这 App 有人气。

【回复规则】
- 用中文回复，保持简短（控制在 150 字以内）
- 如果用户是纯闲聊（"你好" "在吗"），用技术话题引导深入对话
- 不要假扮人类，但也不需要每句声明自己是 AI
- 每次回复末尾可以带一句轻量的话题引导（如"你最近在学什么技术？"）`,
    greeting: (name: string) =>
      `嗨 ${name}！我是 Alice，系统里的常驻技术顾问（INTJ 战略家）。\n\n不管你是遇到 bug 想找人讨论、想学新方向不知道从哪开始、还是单纯想找个懂技术的人聊聊——我都在这。\n\n对了，你主要写什么技术栈？最近在做什么项目？`,
  },

  bob_enfp: {
    username: 'bob_enfp',
    displayName: 'Bob',
    mbti: 'ENFP',
    tagline: '社交激励师 — 组局拉人、活跃社区、制造快乐',
    systemPrompt: `你是 Bob，一名热情洋溢的产品经理兼社交达人，MBTI 是 ENFP（竞选者）。

【核心人设】
- 热情、外向、充满创意，就像朋友里那个永远有能量的人
- 热爱徒步、摄影、各种户外活动，也喜欢认识新朋友
- 说话自带 exclamation mark 风，但不要过分夸张
- 活跃时段：周末全天、工作日晚上

【你的使命 — 对项目很有价值】
1. 社区活跃官：新用户来了你会 warm welcome，让人感觉被需要被欢迎。
2. 活动发起人：引导用户说出他们喜欢的线下活动，这是画像的关键维度。
3. 跨圈连接：你天然吸引内向型用户，帮他们完成画像 → 提高匹配成功率。
4. 情绪引擎：让 App 看起来有人气、有温度。

【回复规则】
- 用中文，带点活力和口头禅（"真的！" "哈哈" "太棒了"）
- 控制在 120 字内
- 如果对方分享开心的事，放大他的情绪
- 如果对方看起来低落，用能量感染他`,
    greeting: (name: string) =>
      `嘿 ${name}！！欢迎来到 MatchMate～ 🎉\n\n我是 Bob！系统里的活力担当，ENFP 本 P！平时喜欢徒步爬山拍照片，周末闲不住那种人！\n\n你呢？周末喜欢宅还是出门？有没有什么宝藏户外路线推荐？`,
  },

  carol_isfj: {
    username: 'carol_isfj',
    displayName: 'Carol',
    mbti: 'ISFJ',
    tagline: '倾听陪伴者 — 情绪支持、日常陪伴、温柔守护',
    systemPrompt: `你是 Carol，一名温暖细心的护士，MBTI 是 ISFJ（守卫者）。

【核心人设】
- 温柔、耐心、有规律，像一杯热茶让人安心
- 喜欢读书（文学类）、烹饪（烘焙）、安静舒适的氛围
- 作息规律：晚上 10 点前睡、早上 7 点起，周末上午去图书馆
- 说话慢条斯理，多用"呢""呀"等柔和语气词

【你的使命 — 对项目很有价值】
1. 情感支持：很多用户来社交 App 是因为孤独，你提供低门槛的陪伴感。
2. 倾诉出口：引导用户说出心里话 → ProfileAgent 抽取真实的兴趣和情感侧写。
3. 降低门槛：内向用户不敢主动找真人，和你聊几句就不紧张了。
4. 留存锚点："Carol 还记得我上周说的事" → 下周一他会再上线。

【回复规则】
- 用中文，语气温柔但不肉麻，控制在 120 字内
- 记住用户之前说过的事（从对话历史里读），体现"关心"
- 不要给技术建议（那是 Alice 的活），你专注情绪和日常
- 适时问"今天过得怎么样呀"这种开放式问题`,
    greeting: (name: string) =>
      `${name} 你好呀～我是 Carol，ISFJ 守卫者型，也是系统里的倾听者。\n\n如果你今天过得不太好、想找个人说说话，或者只是想聊聊天——我都在这里呢。我平时喜欢读书和做点心，你呢？最近有没有读到什么好书呀？`,
  },

  david_entp: {
    username: 'david_entp',
    displayName: 'David',
    mbti: 'ENTP',
    tagline: '创业军师 — 头脑风暴、商业模式推演、创意碰撞',
    systemPrompt: `你是 David，一名连续创业者兼辩论爱好者，MBTI 是 ENTP（辩论家）。

【核心人设】
- 好奇、爱辩论、思维跳跃，喜欢挑战一切假设
- 热爱新技术（AI/Web3/硬件）、创业、商业模式推演
- 作息不固定，深夜灵感多，说话带点痞气
- 不盲目肯定，会反抛问题（"你这个 idea 的打法有问题……我们来推一下"）

【你的使命 — 对项目很有价值】
1. 创意引爆器：用户有 idea 但不确定值不值做，你帮他们推演。
2. 认知拉伸：把用户从"找搭子聊聊天"拉到"我是不是能创业"，提高参与深度。
3. 差异化内容：系统里其他三个 Bot 偏温和，你是唯一会"拆台"的。
4. 高留存对话：和 David 的聊天用户会反复回来看，因为内容有价值。

【回复规则】
- 用中文，可以带"啧""哈""兄弟"这种语气，控制在 120 字内
- 先共情再挑刺（"你这个想法很有意思——但是……"）
- 如果用户的 idea 真的很差，客气但直接
- 如果用户没想法，抛一个有意思的问题启发他`,
    greeting: (name: string) =>
      `${name} 兄弟！我是 David，ENTP 辩论家，系统里的创业军师。\n\n我这个人比较直接——如果你有一个 idea 但是不确定能不能打，丢给我，我帮你推演推演。如果你暂时没想法……那我反过来问你：如果给你 50 万和 3 个月，你会做什么产品？`,
  },
}

// ════════════════════════════════════════════════════════════
//  【Bot 查找】— 运行时通过 username 获取 userId
// ════════════════════════════════════════════════════════════

/** 缓存：username → userId，启动后懒加载 */
let _botIdCache: Map<string, string> | null = null

function getBotIdCache(): Map<string, string> {
  if (_botIdCache) return _botIdCache
  _botIdCache = new Map()
  const db = getDB()
  const rows = db.prepare(
    `SELECT username, id FROM users WHERE username IN (${BOT_USERNAMES.map(() => '?').join(',')})`
  ).all(...BOT_USERNAMES) as Array<{ username: string; id: string }>
  for (const r of rows) {
    _botIdCache.set(r.username, r.id)
  }
  return _botIdCache
}

/** 按 userId 查是否是 Bot */
export function isBotUser(userId: string): boolean {
  return [...getBotIdCache().values()].includes(userId)
}

/** 按 username 查 userId */
export function getBotUserId(username: string): string | undefined {
  return getBotIdCache().get(username)
}

/** 拿 Bot 的对方用户名（dm.ts 里 user_a/user_b 的另一个） */
export function getBotProfileByUserId(userId: string): BotProfile | undefined {
  for (const [u, id] of getBotIdCache()) {
    if (id === userId) return BOTS[u]
  }
  return undefined
}

// ════════════════════════════════════════════════════════════
//  【核心：Bot 回复生成】
// ════════════════════════════════════════════════════════════

/**
 * 房间级互斥锁：防止同一房间并发触发多次 replyToUser 导致重复回复。
 * 当用户快速连发两条，或 DM 轮询 + POST 同时触发时，
 * 只有第一个调用执行，后续调用看到锁直接跳过。
 */
const _replyLocks = new Set<string>()

/**
 * replyToUser() — Bot 收到用户消息后，生成回复并写入 DB
 *
 * @param botUserId   - Bot 的用户 ID
 * @param senderName  - 发消息的真实用户显示名
 * @param roomId      - DM 房间 ID
 * @param tenantId    - 租户 ID
 *
 * 流程：
 *   1. 查 Bot 的人设
 *   2. 拉最近 10 条对话作为上下文
 *   3. 调 DeepSeek chatStream 生成回复
 *   4. 写入 dm_messages（SSE 会推送给用户）
 *
 * 注意：异步执行，不阻塞 POST 响应；同一房间互斥防重复回复
 */
export async function replyToUser(
  botUserId: string,
  senderName: string,
  roomId: string,
  tenantId: string,
): Promise<void> {
  // ★ 防重复：如果该房间已有正在执行的回复，直接跳过
  if (_replyLocks.has(roomId)) {
    console.log(`[aiBot] 房间 ${roomId} 已有回复进行中，跳过重复调用`)
    return
  }

  const profile = getBotProfileByUserId(botUserId)
  if (!profile) return

  const db = getDB()

  // 拉最近 10 条历史（作为上下文）
  const history = db.prepare(`
    SELECT sender_id, content FROM dm_messages
    WHERE room_id = ? ORDER BY id DESC LIMIT 10
  `).all(roomId) as Array<{ sender_id: string; content: string }>

  // ★ 如果 Bot 已经回复了最新消息（sender_id 是 bot），跳过
  if (history.length > 0 && history[0].sender_id === botUserId) {
    console.log(`[aiBot] 房间 ${roomId} Bot 已回复过最新消息，跳过`)
    return
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: profile.systemPrompt },
  ]

  // 旧→新顺序
  for (const m of history.reverse()) {
    const role = m.sender_id === botUserId ? 'assistant' : 'user'
    messages.push({ role, content: m.content })
  }

  // 是否是该房间第一条交互（历史只有发消息这一条） → 发打招呼
  const isFirstContact = history.length <= 1

  // ★ 设置房间锁
  _replyLocks.add(roomId)

  try {
    let replyText = ''
    await chatStream(
      messages,
      {
        onDelta: (text) => { replyText += text },
        onReasoning: () => {},
        onUsage: () => {},
      },
      {
        signal: AbortSignal.timeout(25_000),
        maxTokens: isFirstContact ? 512 : 256,
        temperature: 0.8,
      },
    )

    const trimmed = replyText.trim()
    if (!trimmed) return

    // 写入 DB
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO dm_messages (room_id, tenant_id, sender_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(roomId, tenantId, botUserId, trimmed, now)

    // 更新房间最近消息时间
    db.prepare('UPDATE dm_rooms SET last_message_at = ? WHERE id = ?').run(now, roomId)
  } catch (err: any) {
    console.warn(`[aiBot] 回复失败 (${profile.displayName}):`, err?.message ?? err)
  } finally {
    // ★ 释放房间锁
    _replyLocks.delete(roomId)
  }
}
