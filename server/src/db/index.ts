// ============================================================
// index.ts — 数据库连接管理（better-sqlite3 单例 + WAL 模式）
// 文件路径：server/src/db/index.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件是"数据库大门"——整个服务共用一个连接（单例），       ║
// ║  避免每次查询都开新连接。                                    ║
// ║                                                            ║
// ║  为什么用 SQLite 而不是 MySQL/Postgres？                     ║
// ║  - 零部署：一个文件就是一个数据库（data/matchmate.db）        ║
// ║  - 性能：单机万级 QPS 够搭子匹配这种场景                      ║
// ║  - 备份：直接拷文件就备份了                                  ║
// ║  - 同步：better-sqlite3 同步 API，代码可读性好               ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：小王发消息，db 连接怎么走 ▼▼▼
//
//   服务启动时（只发生一次）：
//        │
//        ▼
//   getDB() 第一次调用
//     - mkdirSync(dirname(config.dbPath)) → 建 data/ 目录
//     - new Database('data/matchmate.db') → 打开文件
//     - db.pragma('journal_mode = WAL') → 开 WAL 模式
//       （Write-Ahead Logging：读写不互斥，性能高）
//     - db.pragma('foreign_keys = ON') → 开外键约束
//     - db.pragma('synchronous = NORMAL') → 平衡安全与性能
//     - 缓存到全局变量 db
//
//   小王发消息时：
//        │
//        ▼
//   chat.ts → getDB() → 拿到缓存的 db（不重新打开）
//     → db.prepare('INSERT INTO conversations ...').run(...)
//     → 写入 data/matchmate.db 文件
//
// ════════════════════════════════════════════════════════════
//  【WAL 模式是什么？为什么开它？】
// ════════════════════════════════════════════════════════════
//   SQLite 默认 DELETE 模式：写时锁定整个数据库文件，读也阻塞
//   WAL 模式（Write-Ahead Logging）：
//   - 写：先写到 -wal 文件，定期合并到主文件
//   - 读：读主文件 + wal 文件，不阻塞写
//   - 效果：读写并发性能大幅提升（适合读多写多场景）
//
//   注意：开了 WAL 会多出 matchmate.db-wal 和 matchmate.db-shm 两个文件
//   正常关机时会合并，别手动删
//
// ════════════════════════════════════════════════════════════
//  【单例模式】
// ════════════════════════════════════════════════════════════
//   let db: Database.Database
//   function getDB() {
//     if (db) return db   // 已有连接直接返回
//     db = new Database(...)  // 第一次才创建
//     return db
//   }
//   好处：整个服务共用一个连接，避免重复打开/关闭的开销
//
// ════════════════════════════════════════════════════════════
//  【在整条链路里的位置】
// ════════════════════════════════════════════════════════════
//   服务启动 → index.ts → initSchema() → getDB() → 建表
//   所有 services/agents/routes 调 getDB() 拿连接 → 读写数据
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：几乎所有人
//   - services/auth.ts, services/rateLimiter.ts
//   - agents/profileAgent.ts, matchAgent.ts, iceBreakerAgent.ts
//   - routes/*.ts（chat/match/profile/dm/auth/privacy）
//   - db/schema.ts, db/vectorStore.ts
//   - scripts/seed.ts
//
//   它调用：
//   - better-sqlite3 → Database 类
//   - config/index.js → config.dbPath（数据库文件路径）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - import Database from 'better-sqlite3' → 导入第三方库
//   - db.pragma('...') → 设置数据库模式（SQLite 专属语法）
//   - let db → 模块级变量，整个进程只有一份（单例）
// ============================================================

import Database from 'better-sqlite3'        // better-sqlite3：Node.js 版 SQLite
import { mkdirSync } from 'fs'                // 创建目录（data/ 文件夹不存在就建）
import { dirname } from 'path'                // 取路径的目录部分
import { config } from '../config/index.js'   // 读 dbPath 配置

// 【单例变量】模块级变量，整个进程只有一份数据库连接
let db: Database.Database

// 【函数】获取数据库连接（懒加载 + 单例）
// 文件路径：server/src/db/index.ts → getDB()
export function getDB(): Database.Database {
  if (db) return db  // 已经有连接了 → 直接返回（单例）

  // 第一次调用 → 创建连接
  mkdirSync(dirname(config.dbPath), { recursive: true })
  //       ↑ 先确保 data/ 目录存在（{ recursive: true } = 父目录不存在也自动建）

  db = new Database(config.dbPath)  // 打开/创建 SQLite 文件

  // 设置数据库模式
  db.pragma('journal_mode = WAL')     // WAL 模式：写不阻塞读（比默认 rollback 模式快）
  db.pragma('foreign_keys = ON')      // 启用外键约束（删用户自动删关联数据）
  db.pragma('synchronous = NORMAL')   // 同步模式：NORMAL（安全与性能平衡，比 FULL 快比 OFF 安全）
  return db
}

// 【函数】关闭数据库连接（程序退出时调）
// 文件路径：server/src/db/index.ts → closeDB()
export function closeDB(): void {
  try { db?.close() } catch { /* 无视关闭错误 */ }
  //      ↑ ?. 可选链：db 是 null/undefined 就不调用 close()
}
