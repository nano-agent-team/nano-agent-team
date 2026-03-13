<template>
  <div class="settings-view">
    <div class="settings-header">
      <h1>⚙️ Settings</h1>
    </div>

    <div class="settings-body">
      <!-- Config status -->
      <div class="settings-section">
        <h2>Stav systému</h2>
        <div class="status-row">
          <span class="status-label">Setup</span>
          <span :class="['status-badge', status.complete ? 'ok' : 'warn']">
            {{ status.complete ? 'Dokončen' : 'Nedokončen' }}
          </span>
        </div>
        <div class="status-row">
          <span class="status-label">Provider</span>
          <span class="status-value">{{ config?.provider?.type ?? '—' }}</span>
        </div>
        <div v-if="status.missing?.length" class="missing-list">
          <span class="missing-label">Chybí:</span>
          <code v-for="m in status.missing" :key="m" class="missing-item">{{ m }}</code>
        </div>
      </div>

      <!-- Chat with settings agent -->
      <div class="settings-section">
        <h2>Asistent</h2>
        <p class="section-desc">Zeptej se na cokoliv ohledně nastavení systému.</p>

        <div class="chat-messages" ref="chatEl">
          <div
            v-for="(msg, i) in messages"
            :key="i"
            :class="['chat-msg', msg.role]"
          >
            <span class="chat-role">{{ msg.role === 'user' ? 'Ty' : '🤖' }}</span>
            <span class="chat-text">{{ msg.text }}</span>
          </div>
          <div v-if="thinking" class="chat-msg assistant thinking">
            <span class="chat-role">🤖</span>
            <span class="chat-text">...</span>
          </div>
        </div>

        <div class="chat-input-row">
          <input
            v-model="chatInput"
            type="text"
            placeholder="Napiš zprávu..."
            class="chat-input"
            :disabled="thinking"
            @keyup.enter="sendMessage"
          />
          <button class="btn-send" :disabled="thinking || !chatInput.trim()" @click="sendMessage">
            Odeslat
          </button>
        </div>
      </div>

      <!-- Installed packages -->
      <div class="settings-section">
        <h2>Nainstalováno</h2>
        <div v-if="config?.installed?.teams?.length" class="installed-group">
          <span class="installed-label">Týmy:</span>
          <code v-for="t in config.installed.teams" :key="t" class="installed-item">{{ t }}</code>
        </div>
        <div v-if="config?.installed?.features?.length" class="installed-group">
          <span class="installed-label">Featury:</span>
          <code v-for="f in config.installed.features" :key="f" class="installed-item">{{ f }}</code>
        </div>
        <div v-if="!config?.installed?.teams?.length && !config?.installed?.features?.length"
             class="empty-installed">
          Nic nenainstalováno.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'

interface Message { role: 'user' | 'assistant'; text: string }
interface ConfigStatus { complete: boolean; missing: string[]; setupCompleted: boolean }

const config = ref<Record<string, any> | null>(null)
const status = ref<ConfigStatus>({ complete: false, missing: [], setupCompleted: false })
const messages = ref<Message[]>([])
const chatInput = ref('')
const thinking = ref(false)
const chatEl = ref<HTMLElement | null>(null)
const sessionId = `settings-${Date.now()}`

onMounted(async () => {
  await Promise.all([loadConfig(), loadStatus()])
  messages.value.push({
    role: 'assistant',
    text: 'Ahoj! Jsem tvůj settings asistent. Zeptej se mě na cokoliv ohledně konfigurace nebo instalace.',
  })
})

async function loadConfig() {
  try {
    const res = await fetch('/api/config')
    if (res.ok) config.value = await res.json() as Record<string, any>
  } catch { /* ignore */ }
}

async function loadStatus() {
  try {
    const res = await fetch('/api/config/status')
    if (res.ok) status.value = await res.json() as ConfigStatus
  } catch { /* ignore */ }
}

async function sendMessage() {
  const text = chatInput.value.trim()
  if (!text || thinking.value) return

  messages.value.push({ role: 'user', text })
  chatInput.value = ''
  thinking.value = true
  await scrollToBottom()

  try {
    const res = await fetch('/api/chat/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId }),
    })

    if (res.ok) {
      const data = await res.json() as { reply: unknown }
      const replyText = typeof data.reply === 'string'
        ? data.reply
        : JSON.stringify(data.reply)
      messages.value.push({ role: 'assistant', text: replyText })
      // Refresh config after agent may have changed it
      await loadConfig()
      await loadStatus()
    } else {
      messages.value.push({ role: 'assistant', text: '(Asistent není dostupný — zkus to znovu)' })
    }
  } catch {
    messages.value.push({ role: 'assistant', text: '(Chyba připojení k asistentovi)' })
  } finally {
    thinking.value = false
    await scrollToBottom()
  }
}

async function scrollToBottom() {
  await nextTick()
  if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
}
</script>

<style scoped>
.settings-view {
  padding: 24px;
  max-width: 720px;
  margin: 0 auto;
  color: var(--text, #e6edf3);
}

.settings-header h1 {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 24px;
}

.settings-section {
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
}

.settings-section h2 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-muted, #8b949e);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 16px;
}

.section-desc {
  font-size: 13px;
  color: var(--text-muted, #8b949e);
  margin: 0 0 12px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 13px;
}

.status-label { color: var(--text-muted, #8b949e); min-width: 80px; }
.status-value { font-family: monospace; }

.status-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}
.status-badge.ok { background: rgba(63, 185, 80, 0.15); color: var(--accent2, #3fb950); }
.status-badge.warn { background: rgba(210, 153, 34, 0.15); color: #d29922; }

.missing-list {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.missing-label { color: var(--danger, #f85149); }
.missing-item {
  background: rgba(248, 81, 73, 0.1);
  color: var(--danger, #f85149);
  padding: 2px 6px;
  border-radius: 4px;
}

.chat-messages {
  height: 200px;
  overflow-y: auto;
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chat-msg {
  display: flex;
  gap: 8px;
  font-size: 13px;
}

.chat-role {
  min-width: 24px;
  font-size: 11px;
  color: var(--text-muted, #8b949e);
  padding-top: 1px;
}

.chat-msg.user .chat-text { color: var(--text, #e6edf3); }
.chat-msg.assistant .chat-text { color: var(--accent, #58a6ff); }
.chat-msg.thinking .chat-text { color: var(--text-muted, #8b949e); font-style: italic; }

.chat-input-row { display: flex; gap: 8px; }

.chat-input {
  flex: 1;
  padding: 8px 12px;
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  color: var(--text, #e6edf3);
  font-size: 13px;
  outline: none;
}
.chat-input:focus { border-color: var(--accent, #58a6ff); }

.btn-send {
  padding: 8px 16px;
  background: var(--accent, #58a6ff);
  color: #0d1117;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.btn-send:disabled { opacity: 0.5; cursor: not-allowed; }

.installed-group {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.installed-label { color: var(--text-muted, #8b949e); min-width: 60px; }
.installed-item {
  background: var(--surface2, #1c2128);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.empty-installed { font-size: 13px; color: var(--text-muted, #8b949e); }
</style>
