<template>
  <div class="input-bar">
    <div class="input-wrap" :class="{ focused }">
      <!-- 图片预览行（选了图才显示） -->
      <div class="image-preview-row" v-if="pendingImages.length">
        <div class="image-chip" v-for="(img, i) in pendingImages" :key="i">
          <img :src="img.data" :alt="img.name" />
          <button class="image-chip-remove" @click="removeImage(i)" title="移除">
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
        ></textarea>

        <div class="input-actions">
          <div class="meta-hint" v-if="!isRunning && rateLimit > 0">
            剩余 {{ rateRemaining }}/{{ rateLimit }}
          </div>
          <!-- 图片上传按钮（非运行中才可点）
               DeepSeek 不识图，但图片作为"活动记录"展示在对话里，
               并在发给 AI 的 content 后附 [图片×N] 提示 AI 上下文 -->
          <button
            v-if="!isRunning"
            class="image-btn"
            :disabled="pendingImages.length >= 4"
            title="发送图片（AI 会知道你发了图，但暂不识图）"
            @click="pickImage"
          >
            <AppIcon name="image" :size="18" />
          </button>
          <button
            v-if="!isRunning"
            class="send-btn"
            :disabled="!canSend"
            @click="onSend"
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
      ref="fileInputRef"
      type="file"
      accept="image/*"
      multiple
      class="hidden-file"
      @change="onFileChange"
    />
    <div class="input-tip">
      <AppIcon name="lightbulb" :size="12" />
      <span>自然聊天即可，AI 会隐式采集你的画像 · Enter 发送 / Shift+Enter 换行</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch } from 'vue'
import AppIcon from '../common/AppIcon.vue'

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
const fileInputRef = ref(null)
const pendingImages = ref([])   // [{ name, data(dataURL), size }]

// 有文字或有图都能发；流式中不能发
const canSend = computed(() => (text.value.trim().length > 0 || pendingImages.value.length > 0) && !props.isRunning)

function onSend() {
  if (!canSend.value) return
  // 把文字和图片一起传给父组件
  emit('send', {
    text: text.value.trim(),
    images: pendingImages.value.slice(),
  })
  text.value = ''
  pendingImages.value = []
  nextTick(autoResize)
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    onSend()
  }
}

function autoResize() {
  const el = taRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

// ─── 图片上传 ───
function pickImage() {
  if (pendingImages.value.length >= 4) return
  fileInputRef.value?.click()
}

function onFileChange(e) {
  const files = Array.from(e.target.files || [])
  for (const f of files) {
    if (pendingImages.value.length >= 4) break
    if (!f.type.startsWith('image/')) continue
    // 限制 2MB，避免 dataURL 过大撑爆前端
    if (f.size > 2 * 1024 * 1024) continue
    readAsDataURL(f).then((data) => {
      pendingImages.value.push({ name: f.name, data, size: f.size })
    })
  }
  // 清空 input 的 value，否则同一文件第二次选不触发 change
  e.target.value = ''
}

function readAsDataURL(file) {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => resolve('')
    r.readAsDataURL(file)
  })
}

function removeImage(i) {
  pendingImages.value.splice(i, 1)
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

/* 图片预览行 */
.image-preview-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
}
.image-chip {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--border-default);
}
.image-chip img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.image-chip-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(0,0,0,0.6);
  color: white;
  border: none;
  cursor: pointer;
}
.image-chip-remove:hover { background: rgba(0,0,0,0.8); }

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
.input-area:focus {
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
.image-btn, .send-btn, .stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  height: 32px;
  min-width: 32px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  border: none;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.image-btn {
  background: transparent;
  color: var(--text-tertiary);
}
.image-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--accent-primary);
}
.image-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.send-btn {
  background: var(--accent-primary);
  color: white;
}
.send-btn:hover:not(:disabled) {
  background: var(--accent-primary-hover);
  box-shadow: var(--shadow-glow);
}
.send-btn:disabled {
  background: var(--bg-active);
  color: var(--text-tertiary);
}
.stop-btn {
  background: var(--danger-soft);
  color: var(--danger);
}
.stop-btn:hover {
  background: var(--danger);
  color: white;
}
.hidden-file {
  display: none;
}
.input-tip {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding: 0 var(--space-2);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}
</style>
