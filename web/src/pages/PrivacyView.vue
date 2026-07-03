<template>
  <div class="privacy-view">
    <header class="page-header">
      <div>
        <h2 class="page-title">隐私中心</h2>
        <p class="page-subtitle">你的数据你做主 · PIPL/GDPR 合规</p>
      </div>
    </header>

    <div class="privacy-body">
      <!-- 隐私承诺 -->
      <div class="card section-card">
        <div class="section-head">
          <AppIcon name="shield" :size="18" />
          <h3>我们的隐私承诺</h3>
        </div>
        <ul class="promise-list">
          <li>
            <AppIcon name="lock" :size="14" />
            <div>
              <strong>密码 bcrypt 哈希</strong>
              <p>永不存明文，cost=12，即使数据库泄露也无法还原密码</p>
            </div>
          </li>
          <li>
            <AppIcon name="lock" :size="14" />
            <div>
              <strong>JWT httpOnly Cookie</strong>
              <p>token 无法被 JS 读取，防御 XSS 窃取会话</p>
            </div>
          </li>
          <li>
            <AppIcon name="users" :size="14" />
            <div>
              <strong>多租户隔离</strong>
              <p>所有查询带 tenant_id，数据绝不跨租户泄露</p>
            </div>
          </li>
          <li>
            <AppIcon name="shield" :size="14" />
            <div>
              <strong>对话原话单表存储</strong>
              <p>便于一键导出/删除，到期自动归档（{{ retentionDays }} 天）</p>
            </div>
          </li>
          <li>
            <AppIcon name="target" :size="14" />
            <div>
              <strong>画像证据可追溯</strong>
              <p>每个画像字段都附带用户原话片段，AI 无法凭空捏造</p>
            </div>
          </li>
          <li>
            <AppIcon name="check" :size="14" />
            <div>
              <strong>匹配不调 LLM</strong>
              <p>召回+排序纯计算，不会把你的画像发给 LLM 做匹配</p>
            </div>
          </li>
        </ul>
      </div>

      <!-- 数据导出 -->
      <div class="card section-card">
        <div class="section-head">
          <AppIcon name="download" :size="18" />
          <h3>导出我的数据</h3>
        </div>
        <p class="section-desc">下载你的全部数据（账号信息、画像、画像演进历史、对话记录、匹配记录），JSON 格式。</p>
        <button class="btn btn-ghost" :disabled="exporting" @click="onExport">
          <span v-if="exporting" class="spinner"></span>
          <AppIcon v-else name="download" :size="16" />
          <span>{{ exporting ? '导出中...' : '导出全部数据' }}</span>
        </button>
      </div>

      <!-- 危险区 -->
      <div class="card section-card danger-card">
        <div class="section-head danger-head">
          <AppIcon name="trash" :size="18" />
          <h3>删除账号</h3>
        </div>
        <p class="section-desc danger-desc">
          此操作不可撤销。将永久删除你的账号、画像、对话记录、匹配记录和所有关联数据。
          删除操作会记入审计日志，但日志不含你的画像内容。
        </p>

        <div class="confirm-box" v-if="confirmOpen">
          <p class="confirm-text">真的要删除账号吗？输入你的用户名确认：</p>
          <input
            v-model="confirmName"
            type="text"
            :placeholder="`输入 ${auth.user?.username} 确认`"
            class="confirm-input"
          />
          <div class="confirm-actions">
            <button class="btn btn-ghost" @click="cancelDelete">取消</button>
            <button
              class="btn btn-danger"
              :disabled="confirmName !== auth.user?.username || deleting"
              @click="doDelete"
            >
              <span v-if="deleting" class="spinner"></span>
              <span>永久删除</span>
            </button>
          </div>
        </div>

        <button v-else class="btn btn-danger" @click="confirmOpen = true">
          <AppIcon name="trash" :size="16" />
          <span>删除我的账号</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '../components/common/AppIcon.vue'
import { useAuthStore } from '../stores/authStore.js'
import { privacyApi, infoApi } from '../api/index.js'

const auth = useAuthStore()
const router = useRouter()

const exporting = ref(false)
const confirmOpen = ref(false)
const confirmName = ref('')
const deleting = ref(false)
const retentionDays = ref(30)

async function onExport() {
  exporting.value = true
  try {
    const data = await privacyApi.export()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `my-matchmate-data-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  } finally {
    exporting.value = false
  }
}

function cancelDelete() {
  confirmOpen.value = false
  confirmName.value = ''
}

async function doDelete() {
  deleting.value = true
  try {
    await privacyApi.deleteAccount()
    await auth.logout()
    router.push('/login')
  } catch (e) {
    alert(e.message || '删除失败')
  } finally {
    deleting.value = false
  }
}

;(async () => {
  try {
    const info = await infoApi.info()
    // retentionDays 不在 info 接口，用默认值即可
    void info
  } catch { /* */ }
})()
</script>

<style scoped>
.privacy-view {
  height: 100vh;
  overflow-y: auto;
  background: var(--bg-base);
}
.page-header {
  padding: var(--space-5) var(--space-8);
  border-bottom: 1px solid var(--border-subtle);
  position: sticky;
  top: 0;
  background: var(--bg-base);
  z-index: 5;
}
.privacy-body {
  max-width: 760px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-6) var(--space-12);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.section-card { padding: var(--space-5); }
.section-head {
  display: flex; align-items: center; gap: var(--space-2);
  margin-bottom: var(--space-4);
  color: var(--text-primary);
}
.section-head h3 { font-size: var(--fs-md); font-weight: 600; }
.section-desc {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: var(--space-4);
}

.promise-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.promise-list li {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}
.promise-list :deep(.app-icon) {
  color: var(--success);
  margin-top: 3px;
  flex-shrink: 0;
}
.promise-list strong {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  font-weight: 600;
}
.promise-list p {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  margin-top: 2px;
  line-height: 1.5;
}

.danger-card {
  border-color: var(--danger-soft);
}
.danger-head { color: var(--danger); }
.danger-head :deep(.app-icon) { color: var(--danger); }
.danger-desc { color: var(--text-secondary); }

.confirm-box {
  padding: var(--space-4);
  background: var(--danger-soft);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-3);
}
.confirm-text { font-size: var(--fs-sm); color: var(--text-primary); margin-bottom: var(--space-3); }
.confirm-input {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  margin-bottom: var(--space-3);
}
.confirm-input:focus {
  border-color: var(--danger);
  outline: none;
}
.confirm-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
