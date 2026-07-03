# 搭子匹配官（DaZi / MatchMate）

> 一个 **多 Agent 协作** 的社交匹配系统。像朋友一样和 AI 聊天，AI 从对话中理解你的兴趣、社交风格、找搭子目标，然后精准推荐合拍的搭子。
>
> 不填表单，不刷卡片。聊着聊着，搭子就来了。

---

## 这是个啥？

```
┌─────────────────────────────────────────────────────────────┐
│  搭子匹配介绍所（MatchMate）                                 │
│                                                               │
│  👨‍💼 ProfileAgent（画像师）                                   │
│      陪聊 + 偷偷记你喜好（不让用户填表）                       │
│                                                               │
│  👩‍💼 MatchAgent（匹配师）                                     │
│      按画像从人堆里挑 5 个最合拍的（向量召回+多因子排序）       │
│                                                               │
│  🧑‍💼 IceBreakerAgent（破冰师）                                │
│      挑完人后帮你想 3 句开场白                                 │
│                                                               │
│  📋 Blackboard（黑板）  👔 Orchestrator（编排器）             │
│      Agent 间不直接对话，全靠公告板贴便条 + 状态机编排流程     │
└─────────────────────────────────────────────────────────────┘
```

**核心特色**：
- 💬 **聊天式画像**：不填表单，AI 从自然对话中抽取兴趣/风格/目标
- 🎯 **可解释匹配**：向量召回 + 5 维因子排序，每个推荐都附"为什么是 TA"
- 🧊 **破冰话术**：匹配后自动生成 3 条不同风格的开场白，降低社交启动成本
- 🛡️ **隐私保护**：破冰师只看画像标签，不看对话原文，从架构层面防泄露
- 🔄 **双模式降级**：LLM + 规则双轨，API 故障时自动降级保证可用

---

## Beta 迭代新增功能

本次迭代围绕"对话体验"做了三大改进：

### 1. 对话体验三件套

| 功能 | 说明 | 关键文件 |
|---|---|---|
| 🧠 **思考过程显示** | 修复 Vue 响应式坑，AI 推理模型的思考过程可见（可折叠） | [chatStore.js](web/src/stores/chatStore.js)、[MessageBubble.vue](web/src/components/MessageBubble.vue) |
| ⏹️ **停止生成** | AbortController 全链路中断（前端 fetch → 后端 SSE → LLM），用户随时打断 | [sse.js](web/src/api/sse.js)、[chat.ts](server/src/routes/chat.ts) |
| 📋 **多会话管理** | 新建/切换/重命名/删除会话，话题分组，画像跨会话累积 | [SessionSidebar.vue](web/src/components/chat/SessionSidebar.vue)、[chat.ts](server/src/routes/chat.ts) |

### 2. 图片能力（融合 DeepSeek-Super）

| 功能 | 说明 | 关键文件 |
|---|---|---|
| 📤 **用户发图** | 上传图片（最多 4 张）晒活动现场，AI 据此追问了解偏好 | [InputBar.vue](web/src/components/layout/InputBar.vue) |
| 🎨 **AI 生图返问** | AI 输出 `[gen:描述]` 标记，前端用 Pollinations.ai 渲染真实图片问用户"喜欢去哪玩" | [MessageBubble.vue](web/src/components/MessageBubble.vue)、[profileAgent.ts](server/src/agents/profileAgent.ts) |

**AI 生图返问场景**：AI 想了解用户偏好的活动场景时，输出 3 张图片（如山顶日出/咖啡馆/图书馆），用户看图选一个，比纯文字问"你喜欢爬山还是咖啡"直观 10 倍。

---

## 技术栈

### 后端（[server/](server/)）
- **Node.js + Express + TypeScript**
- **better-sqlite3**：嵌入式数据库，WAL 模式，零配置开箱跑
- **DeepSeek API**（兼容 OpenAI SDK）：LLM 对话 + 画像抽取
- **本地嵌入**：1536 维向量，召回用余弦相似度
- **多租户设计**：每张表带 tenant_id，单租户演示多租户预留

### 前端（[web/](web/)）
- **Vue 3 + Pinia + Vue Router**
- **Vite** 构建
- **SSE（Server-Sent Events）**：流式对话，推理过程 + 正文双通道
- **Pollinations.ai**：免费免 key 的 AI 生图，URL 拼接即用

### Agent 架构
- **黑板模式**（Blackboard）：Agent 间不直接调用，全靠公告板通信
- **状态机驱动**（Orchestrator）：CHATTING → PROFILE_READY → MATCHING → MATCHED → ICEBREAKING → DONE
- **预算 + 反循环 + 追踪**：生产级 Agent 三件套（防烧钱、防死循环、可调试）

---

## 快速开始

### 环境要求
- Node.js ≥ 18
- npm ≥ 9

### 1. 配置后端
```bash
cd server
cp .env.example .env
# 编辑 .env，填入 DeepSeek API Key（不填也能跑，降级规则模式）
npm install
npm run build
npm start
# 服务跑在 http://localhost:8787
```

### 2. 配置前端
```bash
cd web
npm install
npm run dev
# 前端跑在 http://localhost:5173（自动代理 /api 到后端）
```

### 3. 体验
1. 打开 http://localhost:5173
2. 注册账号（或用 seed 脚本造测试用户：`cd server && npm run seed`）
3. 进聊天页和 AI 聊 5 轮（聊兴趣/风格/目标）
4. 画像置信度 ≥ 0.65 后点"开始匹配"
5. 从候选搭子里选一个，点"要破冰话术"拿 3 条开场白

---

## 项目结构

```
DaZi/
├── server/                    # 后端
│   └── src/
│       ├── agents/            # 三个 Agent
│       │   ├── baseAgent.ts       # 工作手册（抽象基类）
│       │   ├── profileAgent.ts    # 画像师（陪聊+抽画像+流式回复）
│       │   ├── matchAgent.ts      # 匹配师（向量召回+多因子排序）
│       │   └── iceBreakerAgent.ts # 破冰师（生成3条开场白）
│       ├── core/              # Agent 协作基础设施
│       │   ├── blackboard.ts      # 公告板（Agent 间通信）
│       │   ├── orchestrator.ts    # 编排器（状态机）
│       │   ├── antiloop.ts        # 反循环器
│       │   ├── tokenBudget.ts     # token 预算
│       │   └── tracer.ts          # 追踪
│       ├── routes/            # API 路由
│       │   ├── chat.ts            # 对话（SSE 流式 + 多会话 + 停止生成）
│       │   ├── match.ts           # 匹配
│       │   ├── profile.ts         # 画像
│       │   ├── dm.ts              # 私信
│       │   ├── auth.ts            # 注册登录
│       │   └── privacy.ts         # 隐私导出/删号
│       ├── db/                # 数据库
│       │   ├── schema.ts          # 表结构 + 迁移
│       │   └── vectorStore.ts     # 向量存储
│       └── services/          # 外部服务
│           ├── llmClient.ts       # DeepSeek/OpenAI SDK 封装
│           ├── embedding.ts       # 本地向量
│           └── rateLimiter.ts     # 限流
├── web/                       # 前端
│   └── src/
│       ├── pages/             # 页面
│       │   ├── ChatView.vue       # 聊天页（侧栏+消息+输入）
│       │   ├── MatchView.vue      # 匹配页
│       │   ├── ProfileView.vue    # 画像页
│       │   ├── DmListView.vue     # 私信列表
│       │   ├── DmRoomView.vue     # 私信房间
│       │   ├── PrivacyView.vue    # 隐私页
│       │   └── LoginView.vue      # 登录注册
│       ├── components/        # 组件
│       │   ├── chat/
│       │   │   └── SessionSidebar.vue  # 会话侧栏（多会话管理）
│       │   ├── MessageBubble.vue      # 消息气泡（思考框+图片+生图）
│       │   ├── layout/
│       │   │   ├── InputBar.vue       # 输入栏（发图+停止生成）
│       │   │   ├── AppShell.vue       # 应用外壳
│       │   │   └── AppSidebar.vue     # 侧边导航
│       │   ├── MatchCard.vue          # 匹配卡片
│       │   ├── RadarChart.vue         # 雷达图
│       │   └── common/AppIcon.vue     # 图标库
│       ├── stores/            # Pinia 状态
│       │   ├── chatStore.js        # 对话（消息+流式+多会话+停止生成）
│       │   ├── matchStore.js       # 匹配
│       │   ├── profileStore.js     # 画像
│       │   ├── dmStore.js          # 私信
│       │   └── authStore.js        # 鉴权
│       └── api/               # API 封装
│           ├── client.js           # axios 实例
│           ├── sse.js              # SSE 流式（支持 AbortSignal）
│           └── index.js            # 各业务 API
├── AGENTS_DESIGN.md           # Agent 设计大白话版
├── FUNCTION_CHAINS.md         # 11 条功能链路全流程
└── README.md                  # 本文件
```

---

## 核心文档

| 文档 | 内容 |
|---|---|
| [AGENTS_DESIGN.md](AGENTS_DESIGN.md) | Agent 设计大白话版：3 个 Agent 干啥、为啥这么设计、黑板模式、状态机、Beta 迭代新增（思考/停止/多会话/图片） |
| [FUNCTION_CHAINS.md](FUNCTION_CHAINS.md) | 11 条功能链路全流程时序图：发消息、抽画像、匹配、破冰、鉴权、加载历史、隐私、停止生成、多会话、图片 |
| [README.md](README.md) | 本文件：项目总览、快速开始、结构 |

---

## API 速览

### 对话（chat）
| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/chat/sessions` | 列出用户所有会话 |
| POST | `/api/chat/sessions` | 新建会话 |
| PATCH | `/api/chat/sessions/:id` | 重命名会话 |
| DELETE | `/api/chat/sessions/:id` | 删除会话（CASCADE 删消息） |
| GET | `/api/chat/sessions/:id/messages` | 加载某会话消息 |
| POST | `/api/chat/messages` | 发消息（SSE 流式回复，body 带 sessionId + imageCount） |
| GET | `/api/chat/status` | 会话状态（画像置信度/限流/是否可匹配） |

### 匹配（match）
| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/match/run` | 执行匹配（向量召回 + 多因子排序，返回 top 5） |
| GET | `/api/match/history` | 匹配历史 |
| POST | `/api/match/icebreaker` | 生成 3 条破冰话术 |

### 其他
| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/auth/register` / `/login` / `/logout` | 注册/登录/登出 |
| GET | `/api/auth/me` | 当前用户 |
| GET | `/api/profile` / `/history` | 画像 / 画像 patch 历史 |
| GET/POST | `/api/dm/rooms` | 私信房间 |
| GET/POST | `/api/dm/rooms/:id/messages` | 私信消息 |
| GET | `/api/privacy/export` | 导出我的数据（GDPR/PIPL） |
| DELETE | `/api/privacy/account` | 删除账号 |

---

## 成本

**单用户完整链路**（注册 → 聊 5 轮 → 匹配 → 破冰）：
- LLM token：约 5000 in + 1500 out ≈ 0.05 元（DeepSeek 价格）
- DB 操作：约 30 次 INSERT/SELECT
- 向量计算：约 6 次 embed（本地零成本）
- AI 生图：Pollinations.ai 免费

**结论**：单用户完整体验成本 < 0.1 元。

---

## 设计原则

1. **像朋友聊天，不让用户填表** — 信息质量更高，用户不烦
2. **LLM + 规则双轨** — API 故障时自动降级，保证可用性
3. **可解释匹配** — 每个推荐都附"为什么是 TA"，不是黑盒
4. **隐私保护** — 破冰师只看画像标签不看原文，单表存对话便于一键删除
5. **黑板模式解耦 Agent** — 不直接调用，异步可扩展，易加新 Agent
6. **省 token** — 抽画像异步后台跑不阻塞回复，匹配纯计算不调 LLM
