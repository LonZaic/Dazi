# WebSocket 服务（独立、可选、内测用）

> ⚠️ 这个目录是**独立进程**，与主服务（Express @ 8787）解耦。
> 内测完直接删整个 `server/websocket/` 目录即可，主功能不受任何影响。

## 是什么

一个独立运行的 WebSocket 服务，用于**校园网/局域网内测**实时通讯能力。
- 不依赖主 server 代码，只读同一份 sqlite 库做用户鉴权
- 提供：在线列表 / 全局聊天室 / 私信推送 / 心跳保活 / 限频防崩
- 鉴权：浏览器连接时自动带 `mm_token` cookie，服务端验 JWT（与主服务同 secret）

## 与 SSE 私信的关系

| | SSE（主功能，保留） | WS（本目录，内测） |
|---|---|---|
| 用途 | 私信实时推送（dm.ts） | 校园网内测实时聊天 |
| 存储 | 写 dm_messages 表 | 不入库，仅在内存流转 |
| 删除影响 | 删了主功能就废 | 删了主功能完全不受影响 |

**两者并存，互不干扰。**

## 启动

```bash
# 1. 确保主服务已起（写库 + 注册用户）—— 不必同时运行，但 DB 要存在
cd server && npm run dev      # 主服务 @ 8787

# 2. 启动 ws 服务（另开一个终端）
cd server/websocket
node server.js                # 默认 @ 8788
```

环境变量（可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WS_PORT` | `8788` | ws 监听端口 |
| `DB_PATH` | `../data/matchmate.db` | sqlite 路径（与主服务一致） |
| `JWT_SECRET` | `dev-only-insecure-secret-change-me` | JWT 密钥（与主服务一致） |

## 前端访问

开发态走 vite proxy（`/ws` → `8788`），浏览器访问 `http://你本机IP:5177/ws-demo`。
内测时让同校园网的人打开 `http://你的局域网IP:5177/ws-demo`（同一 WiFi 即可）。

## 性能保护（防崩）

| 项 | 阈值 |
|---|---|
| 全局连接上限 | 1000 |
| 单用户连接上限 | 5（多端登录） |
| 单条消息字符上限 | 2000 |
| 限频 | 1 秒内最多 5 条 |
| 心跳间隔 | 30s ping |
| 死连接超时 | 60s 无 pong 即踢 |

调参：改 `server.js` 顶部的常量。

## 删除

```bash
# 内测完，随时删
rm -rf server/websocket
```

然后清理前端引用（如果想彻底干净）：
- `web/src/ws/` 整个目录
- `web/src/pages/WsDemoView.vue`
- `web/src/router/index.js` 里的 `/ws-demo` 路由
- `web/src/components/layout/AppSidebar.vue` 里的 WS 实测入口
- `web/vite.config.js` 里的 `/ws` proxy 配置
- `server/package.json` 里的 `ws` / `@types/ws` 依赖（`npm uninstall ws @types/ws`）

## 协议

### 客户端 → 服务端

```jsonc
{ "type": "ping" }                          // 心跳
{ "type": "chat", "text": "你好" }          // 全局聊天
{ "type": "private", "to": "user-id", "text": "嗨" }  // 私信
```

### 服务端 → 客户端

```jsonc
{ "type": "hello", "me": { "id", "name", "username" } }
{ "type": "online", "users": [{ "id", "name" }] }
{ "type": "presence", "kind": "join|leave", "user": { "id", "name" } }
{ "type": "chat", "from": { "id", "name" }, "text", "at" }
{ "type": "private", "from": { "id", "name" }, "to", "text", "at" }
{ "type": "pong" }
{ "type": "error", "message" }
```
