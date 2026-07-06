<template>
  <div class="input-bar">
    <div class="input-wrap" :class="{ focused }">
      <!-- 文件预览行 -->
      <div class="preview-row" v-if="pendingFiles.length || pendingImages.length">
        <!-- 图片预览 -->
        <div class="image-chip" v-for="(img, i) in pendingImages" :key="'img-'+i">
          <img :src="img.data" :alt="img.name" />
          <button class="chip-remove" @click="removeImage(i)" title="移除">
            <AppIcon name="x" :size="12" />
          </button>
        </div>
        <!-- 文件预览 -->
        <div class="file-chip" v-for="(f, i) in pendingFiles" :key="'file-'+i">
          <span class="file-chip-icon">
            <AppIcon :name="fileIcon(f)" :size="14" />
          </span>
          <span class="file-chip-name">{{ f.name }}</span>
          <button class="chip-remove" @click="removeFile(i)" title="移除">
            <AppIcon name="x" :size="12" />
          </button>
        </div>
      </div>

      <div class="input-row">
        <textarea
          ref="taRef"
          v-model="text"
          class="input-area"
          :placeholder="placeholder"
          rows="1"
          :disabled="isRunning"
          @focus="focused = true"
          @blur="focused = false"
          @keydown="onKey"
          @input="autoResize"
          @paste="onPaste"
        ></textarea>

        <div class="input-actions">
          <div class="meta-hint" v-if="!isRunning && rateLimit > 0">
            剩余 {{ rateRemaining }}/{{ rateLimit }}
          </div>
          <!-- 图片上传 -->
          <button
            v-if="!isRunning"
            class="tool-btn"
            :disabled="pendingImages.length >= 4"
            title="发送图片"
            @click="pickImage"
          >
            <AppIcon name="image" :size="18" />
          </button>
          <!-- 文件上传 -->
          <button
            v-if="!isRunning"
            class="tool-btn"
            :disabled="pendingFiles.length >= 5"
            title="发送文件"
            @click="pickFile"
          >
            <AppIcon name="upload" :size="18" />
          </button>
          <button
            v-if="!isRunning"
            class="send-btn"
            :disabled="!canSend"
            @click="doSend"
          >
            <AppIcon name="send" :size="18" />
          </button>
          <button v-else class="stop-btn" @click="$emit('stop')">
            <AppIcon name="stop" :size="16" />
            <span>停止</span>
          </button>
        </div>
      </div>
    </div>
    <input
      ref="imgInputRef"
      type="file"
      accept="image/*"
      multiple
      class="hidden-file"
      @change="onImageChange"
    />
    <input
      ref="fileInputRef"
      type="file"
      :accept="ACCEPT_FILE"
      multiple
      class="hidden-file"
      @change="onFileChange"
    />
    <div class="input-tip">
      <AppIcon name="lightbulb" :size="12" />
      <span>自然聊天即可 · Enter 发送 / Shift+Enter 换行 · 支持图片OCR识别 · 支持文件上传</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch } from 'vue'
import AppIcon from '../common/AppIcon.vue'
import { extractOfficeContent } from '../../utils/officeExtract.js'

const props = defineProps({
  isRunning: { type: Boolean, default: false },
  placeholder: { type: String, default: '聊聊你最近在忙什么、喜欢什么...' },
  rateRemaining: { type: Number, default: 0 },
  rateLimit: { type: Number, default: 0 },
})

const emit = defineEmits(['send', 'stop'])

const text = ref('')
const focused = ref(false)
const taRef = ref(null)
const imgInputRef = ref(null)
const fileInputRef = ref(null)
const pendingImages = ref([])
const pendingFiles = ref([])

// ─── 文件类型常量（与后端 readFile.ts TEXT_EXTS 对齐 + Office/PDF）───
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'pyw', 'java', 'kt', 'kts',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
  'go', 'rs', 'rb', 'php', 'swift', 'scala',
  'sql', 'prisma', 'graphql', 'gql',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'log', 'sh', 'bash', 'zsh', 'bat', 'ps1',
  'vue', 'svelte', 'astro', 'env', 'dockerfile', 'makefile', 'r',
])
const BINARY_EXTS = new Set(['pdf', 'docx', 'pptx', 'xlsx'])
// 注意：.doc / .ppt / .xls（老 Office 格式）和 .zip/.rar/.7z 不支持，故不在白名单

// 文件选择器 accept 字符串：只展示可解析的文件类型
const ACCEPT_FILE = [
  // 文本/代码
  '.txt','.md','.markdown','.csv','.json','.xml','.html','.htm','.css','.scss','.less',
  '.js','.jsx','.mjs','.cjs','.ts','.tsx',
  '.py','.pyw','.java','.kt','.kts',
  '.c','.cpp','.cc','.cxx','.h','.hpp','.hxx',
  '.go','.rs','.rb','.php','.swift','.scala',
  '.sql','.prisma','.graphql','.gql',
  '.yaml','.yml','.toml','.ini','.cfg','.conf',
  '.log','.sh','.bash','.zsh','.bat','.ps1',
  '.vue','.svelte','.astro','.env','.dockerfile','.makefile','.r',
  // Office（仅新格式）+ PDF
  '.pdf','.docx','.pptx','.xlsx',
].join(',')

const MAX_IMAGE_SIZE = 4 * 1024 * 1024    // 4MB
const MAX_FILE_SIZE = 10 * 1024 * 1024     // 10MB
const MAX_IMAGES = 4
const MAX_FILES = 5

const canSend = computed(() => {
  return (text.value.trim().length > 0 || pendingImages.value.length > 0 || pendingFiles.value.length > 0) && !props.isRunning
})

function doSend() {
  if (!canSend.value) return
  emit('send', {
    text: text.value.trim(),
    images: pendingImages.value.slice(),
    files: pendingFiles.value.slice(),
  })
  text.value = ''
  pendingImages.value = []
  pendingFiles.value = []
  nextTick(() => {
    autoResize()
    taRef.value?.focus()
  })
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    doSend()
  }
}

function autoResize() {
  const el = taRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

// ─── 粘贴：支持图片和文件直接粘贴 ───
function onPaste(e) {
  const items = e.clipboardData?.items
  if (!items) return
  let hasImage = false
  const fileQueue = []
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile()
      if (!f) continue
      if (f.type.startsWith('image/')) {
        hasImage = true
        if (pendingImages.value.length < MAX_IMAGES && f.size <= MAX_IMAGE_SIZE) {
          readAsDataURL(f).then((data) => {
            if (data) pendingImages.value.push({ name: f.name || `paste-${Date.now()}.png`, data, size: f.size })
          })
        }
      } else {
        // 普通文件：走文件解析流程
        fileQueue.push(f)
      }
    }
  }
  if (hasImage || fileQueue.length) {
    // 阻止默认粘贴行为（避免把图片二进制当文字塞进 textarea）
    e.preventDefault()
    // 文本部分仍交给浏览器默认处理（clipboardData.getData('text')）
    const textData = e.clipboardData.getData('text')
    if (textData) {
      // 把文本插入光标处（简单追加，避免插入位置复杂度）
      const ta = taRef.value
      if (ta) {
        const start = ta.selectionStart ?? text.value.length
        const end = ta.selectionEnd ?? text.value.length
        text.value = text.value.slice(0, start) + textData + text.value.slice(end)
        nextTick(() => {
          ta.selectionStart = ta.selectionEnd = start + textData.length
          autoResize()
        })
      } else {
        text.value += textData
      }
    }
    // 异步处理粘贴的文件
    if (fileQueue.length) {
      for (const f of fileQueue) {
        addFile(f)
      }
    }
  }
}

// ─── 图片 ───
function pickImage() {
  imgInputRef.value?.click()
}

function onImageChange(e) {
  const files = Array.from(e.target.files || [])
  for (const f of files) {
    if (pendingImages.value.length >= MAX_IMAGES) break
    if (!f.type.startsWith('image/')) continue
    if (f.size > MAX_IMAGE_SIZE) continue
    readAsDataURL(f).then((data) => {
      if (data) pendingImages.value.push({ name: f.name, data, size: f.size })
    })
  }
  e.target.value = ''
}

function removeImage(i) {
  pendingImages.value.splice(i, 1)
}

// ─── 文件 ───
function getExt(name) {
  return (name || '').split('.').pop()?.toLowerCase() || ''
}

function isTextFile(name) {
  return TEXT_EXTS.has(getExt(name))
}

function isSupportedFile(name) {
  const ext = getExt(name)
  return TEXT_EXTS.has(ext) || BINARY_EXTS.has(ext)
}

function pickFile() {
  fileInputRef.value?.click()
}

async function onFileChange(e) {
  const files = Array.from(e.target.files || [])
  for (const f of files) {
    await addFile(f)
  }
  e.target.value = ''
}

/** addFile() — 加一个文件到待发送列表（自动识别文本/二进制） */
async function addFile(f) {
  if (pendingFiles.value.length >= MAX_FILES) return
  if (f.size > MAX_FILE_SIZE) return
  if (!isSupportedFile(f.name)) return
  if (isTextFile(f.name)) {
    const content = await readAsTextAsync(f)
    pendingFiles.value.push({ name: f.name, content, size: f.size, type: f.type })
  } else {
    const content = await readBinaryContent(f)
    pendingFiles.value.push({ name: f.name, content, size: f.size, type: f.type })
  }
}

function removeFile(i) {
  pendingFiles.value.splice(i, 1)
}

/** readBinaryContent() — Office/PDF 文档前端提取文本，返回字符串 */
async function readBinaryContent(file) {
  try {
    const buffer = await file.arrayBuffer()
    return await extractOfficeContent(buffer, file.name) || ''
  } catch {
    return ''
  }
}

/** readAsTextAsync() — 文本文件读取为字符串（Promise 版） */
function readAsTextAsync(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result || '')
    reader.onerror = () => resolve('')
    reader.readAsText(file)
  })
}

function fileIcon(f) {
  return 'file'
}

function readAsDataURL(file) {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => resolve('')
    r.readAsDataURL(file)
  })
}

watch(() => props.isRunning, () => nextTick(autoResize))
</script>

<style scoped>
.input-bar {
  padding: var(--space-3) var(--space-5) var(--space-4);
  max-width: var(--max-content);
  margin: 0 auto;
  width: 100%;
}
.input-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  transition: all var(--dur-fast) var(--ease-out);
}
.input-wrap.focused {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-primary-soft);
}

/* ─── 预览行 ─── */
.preview-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
}

.image-chip {
  position: relative;
  width: 56px; height: 56px;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--border-default);
  flex-shrink: 0;
}
.image-chip img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}

.file-chip {
  position: relative;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 28px 6px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-hover);
  border: 1px solid var(--border-default);
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 200px;
  flex-shrink: 0;
}
.file-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-remove {
  position: absolute;
  top: 2px; right: 2px;
  width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: rgba(0,0,0,0.5);
  color: white;
  border: none;
  cursor: pointer;
  padding: 0;
}
.chip-remove:hover { background: rgba(0,0,0,0.75); }

/* ─── 输入行 ─── */
.input-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}
.input-area {
  flex: 1;
  resize: none;
  max-height: 160px;
  padding: var(--space-2) 0;
  font-size: var(--fs-md);
  line-height: 1.5;
  color: var(--text-primary);
  background: transparent;
  border: none;
  outline: none;
  box-shadow: none;
}
.input-area::placeholder { color: var(--text-tertiary); }
.input-area:disabled { opacity: 0.6; }

.input-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.meta-hint {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  padding: 0 var(--space-2);
}

.tool-btn, .send-btn, .stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  height: 32px; min-width: 32px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  border: none;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.tool-btn {
  background: transparent;
  color: var(--text-tertiary);
}
.tool-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--accent-primary);
}
.tool-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.send-btn {
  background: var(--accent-primary);
  color: white;
}
.send-btn:hover:not(:disabled) {
  background: var(--accent-primary-hover);
  box-shadow: var(--shadow-glow);
}
.send-btn:disabled { background: var(--bg-active); color: var(--text-tertiary); }
.stop-btn { background: var(--danger-soft); color: var(--danger); }
.stop-btn:hover { background: var(--danger); color: white; }

.hidden-file { display: none; }

.input-tip {
  display: flex; align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding: 0 var(--space-2);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}
</style>
