<!--
  MessageBubble.vue — 单条消息渲染组件（DeepSeek-Super 风格）
  ============================================================
  【这个文件干啥的？】
    把一条消息渲染成聊天气泡。
    - 用户消息：右对齐 + 灰色气泡 + 纯文本
    - AI 消息：左对齐 + 左侧蓝色竖线 + markdown 渲染 + 可折叠思考框

  【在整条链路里的位置】
    ChatView.vue v-for 遍历 chatStore.messages
      → 每条消息传给 MessageBubble 渲染
    流式时：chatStore 累加 text/reasoning → props 变化 → 本组件重渲染

  【谁调用它】
    - ChatView.vue: <MessageBubble :role="m.role" :text="m.text" :reasoning="m.reasoning" :streaming="m.streaming" />

  【关键设计：DeepSeek-Super 聊天模式】
    1. AI 消息无气泡背景，左侧 accent 竖线（区别于用户气泡）
    2. 推理模型的 reasoning 展示在可折叠"思考框"里（流式中展开，结束后可收起）
    3. AI 正文用 markdown 渲染（支持代码块/列表/标题）
    4. 流式中末尾有闪烁光标，结束后消失
    5. 用户消息纯文本，不渲染 markdown（防 XSS）

  【关键 Vue 3 语法点】
    - <script setup>：组合式 API（最简写法）
    - defineProps：声明 props
    - ref/computed：响应式状态/计算属性
    - v-html：渲染 HTML（markdown 转的）
    - :class：动态 class 绑定
    - @click：事件绑定
-->
<template>
  <!-- DeepSeek-Super 聊天模式：AI 左对齐+左侧 accent 竖线+无气泡+markdown；用户右对齐+灰泡 -->
  <div class="msg" :class="role === 'user' ? 'user' : 'ai'">
    <div class="body" :class="{ streaming: streaming && role !== 'user' }">
      <!-- 用户：纯文本灰泡 + 文件卡片 + 可选图片网格（不渲染 markdown，防 XSS） -->
      <template v-if="role === 'user'">
        <div class="user-content">
          <div class="user-bubbles">
            <!-- 文件卡片（在图片和用户气泡上面，独立文件气泡）-->
            <div v-if="files && files.length" class="user-files">
              <div class="file-card" v-for="(f, i) in files" :key="i">
                <div class="file-icon-box">
                  <span class="file-ext">{{ fileExt(f.name) }}</span>
                </div>
                <div class="file-info">
                  <span class="file-name">{{ f.name }}</span>
                  <span class="file-size">{{ formatSize(f.size) }}</span>
                </div>
              </div>
            </div>
            <div v-if="images && images.length" class="user-images" :class="'img-count-' + Math.min(images.length, 4)">
              <img
                v-for="(src, i) in images"
                :key="i"
                :src="src"
                class="user-image"
                loading="eager"
                decoding="async"
                @click="$emit('preview', src)"
                @error="onImgError($event)"
              />
            </div>
            <div v-if="text" class="bubble">{{ text }}</div>
            <!-- 兜底：text 为空且无图片/文件时，不显示气泡；有图片/文件时图片/文件卡片本身即是气泡 -->
          </div>
          <img v-if="userAvatar" :src="userAvatar" class="user-avatar" alt="" />
          <div v-else class="user-avatar user-avatar-initial" :style="{ background: avatarColor || '#6366f1' }">{{ userInitial?.charAt(0) || 'U' }}</div>
        </div>
      </template>

      <!-- AI：先思考框（如果有 reasoning），再正文 -->
      <template v-else>
        <!-- 思考过程框（推理模型专用，可折叠）
             v-if="reasoning"：没思考过程就不显示
             thinkingOpen：true 展开，false 收起 -->
        <div v-if="reasoning" class="thinking-box">
          <div class="thinking-head" @click="thinkingOpen = !thinkingOpen">
            <svg class="thinking-arrow-svg" :class="{ open: thinkingOpen }" width="10" height="10" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <!-- 流式中且还没正文：显示"思考中…"；否则显示"已思考" -->
            <span class="thinking-label">{{ streaming && !text ? '思考中…' : '已思考' }}</span>
          </div>
          <div v-show="thinkingOpen" class="thinking-body">{{ reasoning }}</div>
        </div>

        <!-- 正文 markdown 渲染，无背景，左侧 accent 竖线
             v-html：渲染 marked 转的 HTML（含 [gen:描述] 展开后的 Pollinations 图片）
             streaming class：流式中竖线呼吸高亮 -->
        <div
          class="bubble markdown-body"
          :class="{ streaming }"
          v-html="renderedText"
        ></div>
      </template>

      <!-- 底部时间（非流式时显示） -->
      <div class="msg-bottom-row" v-if="!streaming && time">
        <span class="msg-time">{{ time }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { marked } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark-dimmed.css'

// defineProps：声明组件接收的属性
const props = defineProps({
  role: { type: String, required: true },        // 'user' | 'assistant'
  text: { type: String, default: '' },           // 消息正文
  reasoning: { type: String, default: '' },      // 推理模型思考过程
  streaming: { type: Boolean, default: false },  // 是否流式中
  createdAt: { type: Number, default: 0 },       // 创建时间戳
  userInitial: { type: String, default: 'U' },   // 用户头像首字母
  images: { type: Array, default: () => [] },    // 用户消息附带的图片（dataURL 数组）
  files: { type: Array, default: () => [] },      // 用户消息附带的文件（{name,size}）
  userAvatar: { type: String, default: '' },      // 用户头像 URL
  avatarColor: { type: String, default: '#6366f1' }, // 用户头像背景色
})

// 文件大小格式化
function formatSize(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

// 文件扩展名（大写，最多 4 字符）
function fileExt(name) {
  if (!name) return 'FILE'
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return 'FILE'
  return name.slice(dot + 1).toUpperCase().slice(0, 4)
}

// 点击用户图片时抛 preview 事件，父组件可弹出大图预览
defineEmits(['preview'])

/** 图片加载失败时显示占位底色 */
function onImgError(e) {
  const img = e.target
  if (img) {
    img.style.background = 'var(--bg-hover, #333)'
    img.style.minHeight = '72px'
  }
}

// 思考框默认状态：
//   ★ 修复 bug：之前默认 thinkingOpen=true 导致离开页面再回来所有思考框都展开
//   规则：
//     - 流式中（streaming=true）默认展开，方便看到思考过程
//     - 非流式（历史消息）默认折叠，避免历史消息全部展开
//     - 用户可手动点开/收起
const thinkingOpen = ref(props.streaming)
// streaming 从 true → false（思考完）时自动收起思考框（保留原行为）
watch(() => props.streaming, (now, prev) => {
  if (prev && !now) thinkingOpen.value = false
})

// marked 配置：breaks=true 换行转 <br>，gfm=true 支持 GitHub markdown，highlight 代码高亮
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value
      } catch {}
    }
    try {
      return hljs.highlightAuto(code).value
    } catch {}
    return code
  },
})

/**
 * 图片生成相关：
 *
 * AI 在 system prompt 里被教导：返问用户场景偏好时，用 [gen:图片描述] 输出占位。
 * 前端把 [gen:...] 提取出来，转成结构化 HTML 网格（不依赖 markdown 默认 <p><img></p>），
 * 根据张数自动排版：1 张大图、2 张并排、3+ 张三栏。
 *
 * Pollinations：免费、无需 API key、FLUX 模型，首次生成 3-8s。
 *
 * 【关键 bug 修复史】
 *   1. Math.random() seed → 流式中 src 不断变化 → 浏览器不断取消重发 → "有框无图"
 *      修复：用 prompt 内容做 FNV-1a hash，prompt 不变则 URL 稳定。
 *   2. marked 把每个 ![](url) 渲染成独立 <p><img></p>，CSS 难以做网格排版
 *      修复：先抽出所有 [gen:...] 标记，转成自闭合占位符 {{GEN_0}}，
 *            marked 渲染后再把占位符替换为统一容器的 HTML 网格。
 */

/** FNV-1a 字符串 hash → 稳定 seed（prompt 不变则 URL 不变） */
function hashSeed(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h % 1000000
}

/** 构造单张图片的 Pollinations URL */
function genImageUrl(prompt) {
  const seed = hashSeed(prompt)
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&seed=${seed}&model=flux&nologo=true`
}

/**
 * extractGenMarkers() — 抽取所有 [gen:...] 标记
 *
 * @param {string} md - 原始文本
 * @returns {{ cleaned: string, gens: string[] }}
 *   - cleaned: 把 [gen:...] 替换成 {{GEN_index}} 占位符的文本（交给 marked 渲染）
 *   - gens: 提取出的 prompt 数组
 *
 * 流式中 [gen: 描述 可能还没闭合 ]，正则只匹配完整闭合的 [gen:...]，
 * 未闭合的留给下一帧再处理（避免错误截断）。
 */
function extractGenMarkers(md) {
  const gens = []
  const cleaned = md.replace(/\[gen:\s*([^\]]+)\]/g, (_, desc) => {
    const prompt = desc.trim()
    gens.push(prompt)
    return `{{GEN_${gens.length - 1}}}`
  })
  return { cleaned, gens }
}

/**
 * renderGenGrid() — 把多个 [gen:...] 渲染成统一容器的 HTML 图片网格
 *
 * 排版规则：
 *   1 张 → 单图大尺寸（240×240）
 *   2 张 → 两栏并排（每张 200×200）
 *   3 张 → 三栏（每张 160×160）
 *   4+ 张 → 两行三栏（每张 140×140）
 *
 * 容器 class 带 count-N，CSS 据此决定 grid-template-columns。
 */
function renderGenGrid(gens) {
  if (!gens.length) return ''
  const items = gens.map((p, i) => {
    const url = genImageUrl(p)
    return `<div class="gen-cell" title="${p}"><img src="${url}" alt="${p}" loading="lazy" /><div class="gen-caption">${p}</div></div>`
  }).join('')
  return `<div class="gen-grid count-${Math.min(gens.length, 4)}">${items}</div>`
}

// renderedText：计算属性，把 markdown 文本转 HTML
// 流程：
//   1. 抽取 [gen:...] 标记 → 替换为 {{GEN_N}} 占位符 + 收集 prompt 数组
//   2. marked 解析剩余 markdown（含占位符）
//   3. 把占位符替换为统一容器的 HTML 图片网格
//   4. 流式中末尾加闪烁光标
const renderedText = computed(() => {
  if (!props.text) return props.streaming ? '<span class="streaming-cursor"></span>' : ''
  const { cleaned, gens } = extractGenMarkers(props.text)
  let html = marked.parse(cleaned)
  // 把 {{GEN_N}} 占位符替换为图片网格 HTML
  // marked 可能把占位符包在 <p> 里，先剥掉裸占位符的 <p> 包裹
  html = html.replace(/<p>\s*\{\{GEN_(\d+)\}\}\s*<\/p>/g, (_, i) => renderGenGrid([gens[Number(i)]]))
  // 多个连续占位符如果在同一个 <p> 里（如 {{GEN_0}}\n{{GEN_1}}\n{{GEN_2}}），整体替换
  html = html.replace(/<p>\s*(\{\{GEN_\d+\}\}(?:\s*\{\{GEN_\d+\}\})*)\s*<\/p>/g, (_, block) => {
    const idxs = [...block.matchAll(/\{\{GEN_(\d+)\}\}/g)].map(m => Number(m[1]))
    return renderGenGrid(idxs.map(i => gens[i]))
  })
  // 兜底：还有没替换的裸占位符（如没被 <p> 包裹），逐个替换
  html = html.replace(/\{\{GEN_(\d+)\}\}/g, (_, i) => renderGenGrid([gens[Number(i)]]))
  return props.streaming ? `${html}<span class="streaming-cursor"></span>` : html
})

// time：时间戳格式化为 HH:MM
const time = computed(() => {
  if (!props.createdAt) return ''
  const d = new Date(props.createdAt * 1000)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
})
</script>

<style scoped>
.msg {
  display: flex;
  align-items: flex-start;
  max-width: 82%;
  padding: 6px 0;
  width: 100%;
}
.msg.user {
  margin-left: auto;
  justify-content: flex-end;
}
.user-content {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
}
.user-bubbles {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 0;
}
.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.user-avatar-initial {
  display: flex; align-items: center; justify-content: center;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.body {
  position: relative;
  min-width: 0;
}

.bubble {
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-primary);
  word-break: break-word;
  background: transparent;
  border-radius: var(--radius-md);
  font-weight: 300;
}

/* 用户：右侧灰泡 + 边框 */
.msg.user .bubble {
  background: var(--bg-elevated, #f5f5f5);
  border: 1px solid var(--border-subtle, #e5e5e5);
  border-radius: var(--radius-lg);
  width: fit-content;
  max-width: 100%;
  white-space: pre-wrap;
}

/* AI：无气泡背景，左侧 accent 竖线 */
.msg.ai .body {
  border-left: 2px solid var(--accent-primary, #5b8def);
  padding-left: 14px;
}
.msg.ai .bubble {
  border-radius: var(--radius-md);
  background: transparent;
  border: none;
}

/* ─── 思考过程框（DeepSeek-Super 风格，可折叠）─── */
.thinking-box {
  border-left: 2px solid var(--border-subtle, #d0d0d0);
  border-radius: 0 var(--radius-sm, 4px) var(--radius-sm, 4px) 0;
  margin-bottom: 8px;
  padding-left: 10px;
}
.thinking-head {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  padding: 2px 0;
  color: var(--text-tertiary, #999);
}
.thinking-head:hover { color: var(--text-secondary, #666); }
.thinking-arrow-svg {
  flex-shrink: 0;
  color: var(--text-tertiary, #999);
  transition: transform 0.15s ease;
}
.thinking-arrow-svg.open { transform: rotate(90deg); }
.thinking-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary, #999);
  letter-spacing: 0.3px;
}
.thinking-body {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-tertiary, #999);
  white-space: pre-wrap;
  word-break: break-word;
  padding: 4px 0 6px;
  max-height: 220px;
  overflow-y: auto;
}

/* 流式中：左侧竖线呼吸高亮 */
.msg.ai .body.streaming,
.msg.ai .bubble.streaming {
  border-left-color: var(--accent-primary, #5b8def);
}

.msg-bottom-row {
  margin-top: 4px;
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: var(--text-tertiary);
}
.msg-time { opacity: 0.7; }

/* 流式光标（块状，DeepSeek 风格）
   注意：全局 animations.css 里 .streaming-cursor::after 也定义了 '▊' 字符光标，
   两者叠加会出"两个蓝条错杂"的 bug，这里强制隐藏伪元素，只保留块状光标 */
:deep(.streaming-cursor) {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--accent-primary, #5b8def);
  animation: mb-blink 1s steps(2, start) infinite;
}
:deep(.streaming-cursor::after) {
  content: none;   /* 关掉全局 animations.css 的 '▊' 伪元素，避免双光标 */
}
@keyframes mb-blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

/* markdown 排版（DeepSeek-Super 风格）*/
:deep(.markdown-body) {
  font-size: 14px;
  line-height: 1.65;
  color: var(--text-primary);
}
:deep(.markdown-body p) {
  margin: 0 0 8px;
}
:deep(.markdown-body p:last-child) {
  margin-bottom: 0;
}
:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3),
:deep(.markdown-body h4) {
  margin: 12px 0 6px;
  font-weight: 600;
  line-height: 1.4;
}
:deep(.markdown-body h1) { font-size: 18px; }
:deep(.markdown-body h2) { font-size: 16px; }
:deep(.markdown-body h3) { font-size: 15px; }
:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  margin: 6px 0;
  padding-left: 22px;
}
:deep(.markdown-body li) {
  margin: 2px 0;
}
:deep(.markdown-body code) {
  background: var(--bg-muted, rgba(0,0,0,0.06));
  color: var(--accent-primary, #e06c75);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'SF Mono', Consolas, 'Fira Code', monospace;
  font-size: 12.5px;
}
:deep(.markdown-body pre) {
  background: var(--bg-code, #1e1e1e);
  color: #e6e6e6;
  padding: 14px 16px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 10px 0;
  font-size: 13px;
  line-height: 1.6;
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
}
:deep(.markdown-body pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: inherit;
  line-height: inherit;
}
/* 代码块内 hljs 高亮保持 transparent 背景 */
:deep(.markdown-body pre code.hljs),
:deep(.markdown-body pre code .hljs) {
  background: transparent;
  padding: 0;
}
:deep(.markdown-body blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--border-subtle, #ddd);
  color: var(--text-secondary);
}
:deep(.markdown-body a) {
  color: var(--accent-primary, #5b8def);
  text-decoration: none;
}
:deep(.markdown-body a:hover) { text-decoration: underline; }
:deep(.markdown-body strong) { font-weight: 600; }
:deep(.markdown-body em) { font-style: italic; }
:deep(.markdown-body hr) {
  border: none;
  border-top: 1px solid var(--border-subtle, #ddd);
  margin: 12px 0;
}
:deep(.markdown-body table) {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
}
:deep(.markdown-body th),
:deep(.markdown-body td) {
  border: 1px solid var(--border-subtle, #ddd);
  padding: 4px 8px;
}

/* ─── 用户文件气泡（独立卡片，在用户消息上方）─── */
.user-files {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
  margin-left: auto;
  max-width: 260px;
  width: 100%;
}
.file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-elevated, #f5f5f5);
  border: 1px solid var(--border-subtle, #e5e5e5);
  cursor: default;
  transition: background var(--dur-fast);
}
.file-card:hover {
  background: var(--bg-hover, #eee);
}
.file-icon-box {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--accent, #4a6cf7);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.file-ext {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  line-height: 1;
}
.file-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.file-info .file-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-info .file-size {
  font-size: 11px;
  color: var(--text-tertiary, #999);
}

/* ─── 用户图片网格 ─── 
   1-3 张：单行，最多 3 栏
   4 张：  2×2 网格
   5+ 张：3 栏自动换行 */
.user-images {
  display: grid;
  gap: 6px;
  margin-bottom: 6px;
  margin-left: auto;
  width: fit-content;
}
.user-images.img-count-1 { grid-template-columns: 140px; }
.user-images.img-count-2 { grid-template-columns: repeat(2, 100px); }
.user-images.img-count-3 { grid-template-columns: repeat(3, 80px); }
.user-images.img-count-4 { grid-template-columns: repeat(2, 110px); }

.user-image {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border-subtle, #e5e5e5);
  cursor: pointer;
  transition: transform var(--dur-fast, 0.15s) ease;
  background: var(--bg-hover, #333);
  display: block;
}
.user-image:hover { transform: scale(1.04); }

/* ─── AI 生成的 Pollinations 图片网格 ───
   按张数自适应排版：1张大图 / 2张并排 / 3张三栏 / 4+两行三栏
   关键：容器 grid 布局，每张图等比缩放，加载中给浅灰底避免跳动 */
:deep(.gen-grid) {
  display: grid;
  gap: 8px;
  margin: 10px 0 8px;
  width: 100%;
  max-width: 420px;
}
:deep(.gen-grid.count-1) { grid-template-columns: 1fr; max-width: 240px; }
:deep(.gen-grid.count-2) { grid-template-columns: repeat(2, 1fr); max-width: 340px; }
:deep(.gen-grid.count-3) { grid-template-columns: repeat(3, 1fr); max-width: 420px; }
:deep(.gen-grid.count-4) { grid-template-columns: repeat(3, 1fr); max-width: 420px; }

:deep(.gen-cell) {
  position: relative;
  aspect-ratio: 1 / 1;          /* 强制正方形，多张图整齐对齐 */
  border-radius: var(--radius-md, 8px);
  overflow: hidden;
  border: 1px solid var(--border-subtle, #e5e5e5);
  background: var(--bg-hover, #f0f0f0);   /* 加载占位底色 */
  cursor: pointer;
  transition: transform var(--dur-fast, 0.15s) ease;
}
:deep(.gen-cell:hover) { transform: scale(1.02); }
:deep(.gen-cell img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
:deep(.gen-caption) {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 4px 6px;
  font-size: 11px;
  color: white;
  background: linear-gradient(transparent, rgba(0,0,0,0.7));
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0;
  transition: opacity var(--dur-fast, 0.15s) ease;
}
:deep(.gen-cell:hover .gen-caption) { opacity: 1; }
</style>
