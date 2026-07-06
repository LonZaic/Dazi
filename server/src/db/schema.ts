// ============================================================
// schema.ts — 数据库表结构定义 + 迁移（多租户 + 隐私合规）
// 文件路径：server/src/db/schema.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是"数据库建筑师"——定义有哪些表、每张表长什么样。     ║
// ║  服务启动时自动调 initSchema()，表不存在就建，存在就跳过。    ║
// ║                                                            ║
// ║  设计要点：                                                 ║
// ║  1. 多租户：每张业务表带 tenant_id（未来一家公司一个租户）    ║
// ║  2. 隐私合规：对话原话单表存储，便于一键导出/删除（PIPL/GDPR）║
// ║  3. 画像版本：profile_json + version + profile_patches 审计  ║
// ║  4. 级联删除：外键 ON DELETE CASCADE（删用户自动删关联数据） ║
// ║  5. 幂等迁移：IF NOT EXISTS + PRAGMA table_info 检查列存在   ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王注册到匹配，涉及哪些表 ▼▼▼
//
//   ① 注册
//   小王填表 → INSERT INTO users (id, tenant_id, username, password_hash, ...)
//   表：users（用户表）
//
//   ② 聊天
//   小王发消息 → INSERT INTO conversations (user_id, role, content, session_id, ...)
//   表：conversations（对话表，单表存所有原话）
//   表：chat_sessions（会话表，一个用户多个话题分组）
//
//   ③ 画像采集
//   ProfileAgent 抽取 → INSERT INTO profiles (user_id, profile_json, confidence, embedding, ...)
//                     → INSERT INTO profile_patches (user_id, version, patch_json, ...)
//   表：profiles（画像表，JSON 存+向量字段）
//   表：profile_patches（画像变更历史，审计用）
//
//   ④ 匹配
//   MatchAgent 匹配 → INSERT INTO matches (user_a, user_b, score, factors_json, explanation, ...)
//   表：matches（匹配记录表，带 5 维因子明细）
//
//   ⑤ 破冰 + 私信
//   IceBreaker → UPDATE matches SET icebreakers_json = ...
//   小王发私信 → INSERT INTO dm_rooms / dm_messages
//   表：dm_rooms（私信房间，按字典序保证唯一）
//   表：dm_messages（私信消息）
//
//   ⑥ 限流
//   每条消息 → INSERT INTO rate_counters (key, count, expires_at)
//   表：rate_counters（限流计数，按用户+小时桶）
//
// ════════════════════════════════════════════════════════════
//  【表关系图】
// ════════════════════════════════════════════════════════════
//   tenants（租户）
//     └── users（用户）──┬── profiles（画像）
//                        ├── profile_patches（画像变更历史）
//                        ├── conversations（对话）── chat_sessions（会话）
//                        ├── matches（匹配记录）
//                        ├── dm_rooms（私信房间）── dm_messages（私信消息）
//                        └── rate_counters（限流）
//   audit_log（审计日志）  prompt_versions（Prompt 版本）
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   服务启动 → index.ts → initSchema() → 建表（幂等）
//   所有 DB 操作都依赖这些表已建好
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - index.ts: initSchema()（服务启动时建表）
//   - scripts/seed.ts: initSchema()（种子脚本前确保表存在）
//
//   它调用：
//   - db/index.js → getDB（拿数据库连接）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - db.exec(sql) → 执行多条 SQL（建表用）
//   - PRAGMA table_info → 查表结构（SQLite 专属）
//   - unixepoch() → SQLite 内置函数，返回当前 Unix 时间戳
//   - as Array<{...}> → 类型断言
// ============================================================

import { getDB } from './index.js'  // 数据库连接

/** 老数据迁移用：从消息内容派生会话标题（取前 16 字） */
// 文件路径：server/src/db/schema.ts → deriveTitle()
function deriveTitle(text: string): string {
  const t = (text || '').trim().replace(/\s+/g, ' ')  // 去首尾空格 + 连续空格变一个
  return t ? (t.length > 16 ? t.slice(0, 16) + '…' : t) : '历史对话'
  //      ↑ 有内容 → 超 16 字截断加省略号；无内容 → "历史对话"
}

/**
 * 初始化所有表。幂等执行（跑多次不报错、不重复建）。
 * 文件路径：server/src/db/schema.ts → initSchema()
 *
 * 关键设计：
 *  - profile 用 JSON 字段存增量 patch 历史 + 当前合并版
 *  - 候选人向量单独存储，召回走 SQL 内余弦计算
 *  - audit_log 记录所有 admin 操作
 *  - conversations 单表，便于一键导出/删除（GDPR/PIPL）
 */
export function initSchema(): void {
  const db = getDB()

  // db.exec 一次执行所有 CREATE TABLE（IF NOT EXISTS 保证幂等）
  db.exec(`
    -- ─── 租户表（多租户：未来一家公司一个 tenant_id）───
    CREATE TABLE IF NOT EXISTS tenants (
      id          TEXT PRIMARY KEY,              -- 租户 ID（如 'default'）
      name        TEXT NOT NULL,                 -- 租户名
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())  -- 创建时间（Unix 时间戳）
    );

    -- ─── 用户表 ───
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,            -- 用户 ID（UUID）
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),  -- 所属租户（外键）
      username      TEXT NOT NULL,               -- 用户名
      password_hash TEXT NOT NULL,               -- bcrypt 哈希（不存明文！）
      display_name  TEXT,                        -- 显示名（可改）
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(tenant_id, username)                -- 同租户内用户名唯一
    );
    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);  -- 按租户查的索引

    -- ─── 画像表（核心：用户画像存这）───
    -- version 支持增量 patch 可追溯
    CREATE TABLE IF NOT EXISTS profiles (
      user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,  -- 删用户自动删画像
      tenant_id     TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 0,   -- 画像版本（每更新一次 +1）
      profile_json  TEXT NOT NULL DEFAULT '{}',   -- 当前合并后的完整画像（JSON）
      confidence    REAL NOT NULL DEFAULT 0,      -- 整体置信度（0-1）
      embedding     TEXT,                          -- 画像文本的向量（JSON 数组，给 MatchAgent 召回用）
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_tenant ON profiles(tenant_id);

    -- ─── 画像增量 patch 历史（审计用：可追溯"AI 怎么画像我的"）───
    CREATE TABLE IF NOT EXISTS profile_patches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增 ID
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id   TEXT NOT NULL,
      version     INTEGER NOT NULL,                    -- 对应画像的第几版
      patch_json  TEXT NOT NULL,                       -- 这轮提取的增量（兴趣/风格/目标...）
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_patches_user ON profile_patches(user_id);

    -- ─── 对话原话（隐私核心：单表存储，可一键导出/删除/到期归档）───
    CREATE TABLE IF NOT EXISTS conversations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id   TEXT NOT NULL,
      role        TEXT NOT NULL,            -- 'user'（用户说的） | 'assistant'（AI 回的）
      content     TEXT NOT NULL,            -- 消息内容
      meta_json   TEXT DEFAULT '{}',        -- 元数据（画像抽取 trace 等）
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_conv_user_time ON conversations(user_id, created_at);

    -- ─── 匹配记录（可解释：factor 拆分存档）───
    CREATE TABLE IF NOT EXISTS matches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     TEXT NOT NULL,
      user_a        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 发起匹配的用户
      user_b        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 被匹配的用户
      score         REAL NOT NULL,          -- 匹配分数（0-1）
      factors_json  TEXT NOT NULL,          -- 各维度因子明细（向量/兴趣/风格/时段/目标）
      explanation   TEXT,                   -- LLM 生成的可解释（"为什么推荐"）
      state         TEXT NOT NULL DEFAULT 'suggested', -- suggested|viewed|icebroken|rejected
      icebreakers_json TEXT,                -- 破冰话术（JSON 数组）
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_matches_tenant_a ON matches(tenant_id, user_a);

    -- ─── 限流计数（按用户/小时）───
    CREATE TABLE IF NOT EXISTS rate_counters (
      key         TEXT PRIMARY KEY,         -- 格式: userId:hour:hourBucket
      count       INTEGER NOT NULL DEFAULT 0,
      expires_at  INTEGER NOT NULL          -- 过期时间（到点自动清理）
    );

    -- ─── 审计日志（admin 操作留痕，合规要求）───
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      actor       TEXT NOT NULL,            -- 操作者
      action      TEXT NOT NULL,            -- 操作类型（如 delete_account）
      target      TEXT,                     -- 操作对象
      meta_json   TEXT DEFAULT '{}',        -- 附加信息
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ─── Prompt 版本治理（Agent 的 prompt 可版本管理）───
    CREATE TABLE IF NOT EXISTS prompt_versions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent       TEXT NOT NULL,            -- profile|match|icebreaker
      version     TEXT NOT NULL,
      content     TEXT NOT NULL,            -- prompt 内容
      active      INTEGER NOT NULL DEFAULT 0,  -- 1=当前启用，0=历史
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ─── 私信房间（两个用户之间一个房间）───
    -- user_a/user_b 按字典序保证唯一（防 A→B 和 B→A 建两个房间）
    CREATE TABLE IF NOT EXISTS dm_rooms (
      id              TEXT PRIMARY KEY,             -- UUID
      tenant_id       TEXT NOT NULL,
      user_a          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 字典序较小者
      user_b          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 字典序较大者
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      last_message_at INTEGER NOT NULL DEFAULT 0,  -- 最近消息时间（列表排序用）
      UNIQUE(tenant_id, user_a, user_b)            -- 同一对用户只能有一个房间
    );
    CREATE INDEX IF NOT EXISTS idx_dm_rooms_user ON dm_rooms(tenant_id, user_a);
    CREATE INDEX IF NOT EXISTS idx_dm_rooms_user_b ON dm_rooms(tenant_id, user_b);

    -- ─── 私信消息 ───
    CREATE TABLE IF NOT EXISTS dm_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id     TEXT NOT NULL REFERENCES dm_rooms(id) ON DELETE CASCADE,
      tenant_id   TEXT NOT NULL,
      sender_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,            -- 消息文本内容
      meta_json   TEXT DEFAULT '{}',         -- 附件: {images:[dataURL,...], files:[{name,size,type,content},...]}
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      read_at     INTEGER                   -- NULL=未读，时间戳=已读时间
    );
    CREATE INDEX IF NOT EXISTS idx_dm_messages_room ON dm_messages(room_id, id);
    CREATE INDEX IF NOT EXISTS idx_dm_messages_unread ON dm_messages(tenant_id, read_at);

    -- ─── 对话会话（多会话管理：一个用户可有多个话题分组）───
    -- 画像仍 per-user（跨会话累积），会话只做消息分组
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id          TEXT PRIMARY KEY,             -- 'sess_' + timestamp + random
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id   TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT '新对话',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, updated_at);
  `)

  // ─── 迁移：dm_messages 加 meta_json 列（老库没有）───
  const dmCols = db.prepare('PRAGMA table_info(dm_messages)').all() as Array<{ name: string }>
  if (!dmCols.some(c => c.name === 'meta_json')) {
    db.exec("ALTER TABLE dm_messages ADD COLUMN meta_json TEXT DEFAULT '{}'")
  }

  // ─── 迁移：给 conversations 加 session_id 列（老库没有）───
  // SQLite 不支持 ADD COLUMN IF NOT EXISTS，用 PRAGMA table_info 检查
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'session_id')) {
    // some()：只要有一列叫 session_id 就返回 true；没有 → 需要加列
    db.exec('ALTER TABLE conversations ADD COLUMN session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE')
    db.exec('CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id, id)')
  }

  // ─── 迁移：把老库 session_id 为 NULL 的 conversations 关联到默认会话 ───
  // 老用户在多会话功能上线前聊过天，消息没 session_id，
  // 不迁移的话老用户看不到历史消息（loadHistory 按 session_id 查）
  const orphans = db.prepare(`
    SELECT DISTINCT user_id, tenant_id FROM conversations
    WHERE session_id IS NULL
  `).all() as Array<{ user_id: string; tenant_id: string }>

  for (const o of orphans) {
    // 给每个有孤儿消息的用户创建一个"历史对话"会话
    const sid = `sess_legacy_${o.user_id}_${Math.random().toString(36).slice(2, 8)}`
    const firstMsg = db.prepare(`SELECT content FROM conversations WHERE user_id = ? AND session_id IS NULL ORDER BY id ASC LIMIT 1`).get(o.user_id) as { content: string } | undefined
    const title = firstMsg ? deriveTitle(firstMsg.content) : '历史对话'
    db.prepare(`INSERT INTO chat_sessions (id, user_id, tenant_id, title) VALUES (?, ?, ?, ?)`).run(sid, o.user_id, o.tenant_id, title)
    db.prepare(`UPDATE conversations SET session_id = ? WHERE user_id = ? AND session_id IS NULL`).run(sid, o.user_id)
  }

  // 默认租户（单租户演示用，多租户预留）
  const hasTenant = db.prepare('SELECT 1 FROM tenants WHERE id = ?').get('default')
  if (!hasTenant) {
    db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run('default', '默认租户')
  }
}
