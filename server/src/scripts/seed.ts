// ============================================================
// seed.ts — 种子数据脚本（让单人也能体验完整匹配流程）
// 文件路径：server/src/scripts/seed.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  你刚注册一个新用户，没人可匹配怎么办？                     ║
// ║  跑 `npm run seed` 就会创建 10 个虚拟用户，各自带画像+向量   ║
// ║  覆盖不同兴趣/风格/目标。一注册就能匹配到人，体验完整流程。 ║
// ║                                                            ║
// ║  密码统一 Demo1234，测试时也能登录这些虚拟用户查看效果。    ║
// ╚══════════════════════════════════════════════════════════╝
//
// 【关键 TS 语法点】
//   - interface → 定义数据结构
//   - Partial<Profile> → Profile 的部分字段（可选）
//   - { ...base(userId), ...partial } → 对象展开合并
//   - randomUUID() → 生成唯一 ID
//   - embedLocal() → 本地算向量（不调 API）
// ============================================================

import { getDB } from '../db/index.js'  // 数据库连接
import { initSchema } from '../db/schema.js'  // 建表
import { hashPassword } from '../services/auth.js'  // 密码哈希
import { embedLocal } from '../services/embedding.js'  // 本地嵌入向量
import { profileToText, type Profile } from '../agents/profileSchema.js'  // 画像类型+转文本
import { randomUUID } from 'crypto'  // UUID 生成

// 【interface】种子用户结构
interface SeedUser {
  username: string    // 登录用户名
  displayName: string // 显示名
  profile: Profile    // 完整画像
}

// 【工厂函数】生成一个空画像模板（后面用 partial 覆盖部分字段）
const base = (userId: string): Profile => ({
  basic: { userId, createdAt: Date.now(), version: 1 },
  interests: [],
  socialStyle: { energy: 'unknown', depth: 'unknown' },
  schedule: [],
  goal: '',
  constraints: [],
  confidence: 0,
})

// 【工厂函数】把 partial 合并到 base 上，生成完整画像
// 文件路径：server/src/scripts/seed.ts → makeProfile()
function makeProfile(userId: string, partial: Partial<Profile>): Profile {
  // Partial<Profile>：Profile 的所有字段都变可选
  // ...partial 覆盖 ...base 的同名字段
  return { ...base(userId), ...partial, basic: { userId, createdAt: Date.now(), version: 1 } }
}

// ─── 10 个虚拟用户数据 ───
// 覆盖不同兴趣组合/社交风格/目标/时段，保证匹配引擎有素材可排
const seedUsers: SeedUser[] = [
  {
    username: 'linn', displayName: '林夕',
    profile: makeProfile('x', {
      interests: [
        { name: '运动', confidence: 0.9, evidence: ['跑步', '羽毛球'] },
        { name: '音乐', confidence: 0.7, evidence: ['吉他'] },
        { name: '旅行', confidence: 0.6, evidence: ['自驾'] },
      ],
      socialStyle: { energy: 'extrovert', depth: 'mixed' },
      schedule: ['weekend', 'evening'],
      goal: '找一个周末一起跑步打球的搭子',
      constraints: ['北京'],
      confidence: 0.78,
    }),
  },
  {
    username: 'anna', displayName: 'Anna',
    profile: makeProfile('x', {
      interests: [
        { name: '游戏', confidence: 0.85, evidence: ['Switch', '原神'] },
        { name: '影视', confidence: 0.7, evidence: ['动漫'] },
        { name: '美食', confidence: 0.5, evidence: ['探店'] },
      ],
      socialStyle: { energy: 'introvert', depth: 'deep' },
      schedule: ['evening', 'night'],
      goal: '找一起打游戏看番的朋友',
      constraints: [],
      confidence: 0.72,
    }),
  },
  {
    username: 'kev', displayName: '凯文',
    profile: makeProfile('x', {
      interests: [
        { name: '运动', confidence: 0.8, evidence: ['健身', '篮球'] },
        { name: '游戏', confidence: 0.7, evidence: ['LOL'] },
        { name: '读书', confidence: 0.5, evidence: ['心理学'] },
      ],
      socialStyle: { energy: 'extrovert', depth: 'surface' },
      schedule: ['weekday', 'evening'],
      goal: '下班后一起健身打球',
      constraints: ['上海'],
      confidence: 0.75,
    }),
  },
  {
    username: 'momo', displayName: '墨墨',
    profile: makeProfile('x', {
      interests: [
        { name: '读书', confidence: 0.9, evidence: ['小说', '哲学'] },
        { name: '音乐', confidence: 0.7, evidence: ['古典', '钢琴'] },
        { name: '影视', confidence: 0.6, evidence: ['纪录片'] },
      ],
      socialStyle: { energy: 'introvert', depth: 'deep' },
      schedule: ['weekend', 'night'],
      goal: '找个能深度交流的读书搭子',
      constraints: [],
      confidence: 0.80,
    }),
  },
  {
    username: 'zoe', displayName: '佐伊',
    profile: makeProfile('x', {
      interests: [
        { name: '旅行', confidence: 0.9, evidence: ['露营', '摄影'] },
        { name: '运动', confidence: 0.7, evidence: ['徒步', '爬山'] },
        { name: '美食', confidence: 0.6, evidence: ['咖啡'] },
      ],
      socialStyle: { energy: 'extrovert', depth: 'mixed' },
      schedule: ['weekend'],
      goal: '周末一起露营爬山拍照',
      constraints: ['杭州'],
      confidence: 0.82,
    }),
  },
  {
    username: 'rex', displayName: '雷克斯',
    profile: makeProfile('x', {
      interests: [
        { name: '游戏', confidence: 0.9, evidence: ['PS5', '主机'] },
        { name: '影视', confidence: 0.8, evidence: ['Netflix', '电影'] },
        { name: '美食', confidence: 0.5, evidence: ['品酒'] },
      ],
      socialStyle: { energy: 'introvert', depth: 'surface' },
      schedule: ['night'],
      goal: '晚上一起开黑看电影',
      constraints: [],
      confidence: 0.70,
    }),
  },
  {
    username: 'yuki', displayName: '雪',
    profile: makeProfile('x', {
      interests: [
        { name: '音乐', confidence: 0.9, evidence: ['乐队', '演唱会'] },
        { name: '旅行', confidence: 0.7, evidence: ['旅游'] },
        { name: '美食', confidence: 0.6, evidence: ['探店'] },
      ],
      socialStyle: { energy: 'extrovert', depth: 'deep' },
      schedule: ['weekend', 'evening'],
      goal: '一起去看演出逛吃逛吃',
      constraints: ['成都'],
      confidence: 0.77,
    }),
  },
  {
    username: 'tom', displayName: '汤姆',
    profile: makeProfile('x', {
      interests: [
        { name: '运动', confidence: 0.85, evidence: ['骑行', '游泳'] },
        { name: '旅行', confidence: 0.7, evidence: ['自驾'] },
        { name: '读书', confidence: 0.5, evidence: ['历史'] },
      ],
      socialStyle: { energy: 'ambivert', depth: 'mixed' },
      schedule: ['weekend', 'morning'],
      goal: '周末骑行自驾搭子',
      constraints: [],
      confidence: 0.73,
    }),
  },
  {
    username: 'lucy', displayName: '露西',
    profile: makeProfile('x', {
      interests: [
        { name: '美食', confidence: 0.9, evidence: ['烘焙', '做饭'] },
        { name: '音乐', confidence: 0.6, evidence: ['说唱'] },
        { name: '影视', confidence: 0.5, evidence: ['综艺'] },
      ],
      socialStyle: { energy: 'extrovert', depth: 'surface' },
      schedule: ['weekend', 'afternoon'],
      goal: '一起探店烘焙喝下午茶',
      constraints: ['广州'],
      confidence: 0.68,
    }),
  },
  {
    username: 'max', displayName: '麦克斯',
    profile: makeProfile('x', {
      interests: [
        { name: '游戏', confidence: 0.8, evidence: ['Steam', '手游'] },
        { name: '运动', confidence: 0.7, evidence: ['足球'] },
        { name: '读书', confidence: 0.6, evidence: ['编程'] },
      ],
      socialStyle: { energy: 'ambivert', depth: 'deep' },
      schedule: ['weekday', 'night'],
      goal: '工作日晚上一起开黑或聊技术',
      constraints: [],
      confidence: 0.74,
    }),
  },
]

// ─── 主函数：创建种子数据 ───
// 文件路径：server/src/scripts/seed.ts → main()
async function main() {
  initSchema()  // 确保表已建好
  const db = getDB()
  const tenantId = 'default'
  const demoPwHash = hashPassword('Demo1234')  // 统一密码哈希

  let inserted = 0  // 计数：实际新增了几个
  for (const su of seedUsers) {
    // 幂等：已存在的跳过（防重复跑 seed 搞出重复用户）
    const exists = db.prepare('SELECT 1 FROM users WHERE tenant_id = ? AND lower(username) = lower(?)').get(tenantId, su.username)
    if (exists) {
      console.log(`  跳过 ${su.username}（已存在）`)
      continue
    }

    const userId = randomUUID()  // 生成唯一用户 ID
    su.profile.basic.userId = userId  // 修正画像里的 userId（之前是占位 'x'）

    // ① 写入用户表
    db.prepare(`
      INSERT INTO users (id, tenant_id, username, password_hash, display_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, tenantId, su.username, demoPwHash, su.displayName)

    // ② 画像转文本 → 算向量
    const profileJson = JSON.stringify(su.profile)
    const profileText = profileToText(su.profile)  // 画像 → 纯文本（喂给 embedding）
    const vec = embedLocal(profileText)            // 文本 → 256 维向量

    // ③ 写入画像表（含向量，MatchAgent 召回用）
    db.prepare(`
      INSERT INTO profiles (user_id, tenant_id, profile_json, confidence, version, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, tenantId, profileJson, su.profile.confidence, 1, JSON.stringify(vec))

    inserted++
    console.log(`  ✓ ${su.displayName} (@${su.username}) — 兴趣:${su.profile.interests.map(i => i.name).join('/')} 置信度:${su.profile.confidence}`)
  }

  console.log(`\n种子完成：新增 ${inserted} 个虚拟用户，共 ${seedUsers.length} 个候选可匹配`)
  console.log('登录信息：用户名见上，密码统一 Demo1234')
}

// 执行主函数，失败退出码 1
main().catch(e => {
  console.error('种子失败：', e)
  process.exit(1)
})
