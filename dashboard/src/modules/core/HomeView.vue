<template>
  <div class="workspace">

    <!-- LEFT: Workflow graph panel -->
    <aside class="graph-panel">
      <div class="panel-head">
        <span class="panel-title">WORKFLOW</span>
        <span class="count-badge">{{ agents.length }}</span>
      </div>

      <WorkflowGraph
        :agents="agents"
        @select-agent="selectedAgentId = $event"
      />

      <!-- Mini stats -->
      <div class="panel-foot">
        <span class="foot-stat">
          <span class="foot-dot dot-running" />
          {{ agents.filter(a => a.status === 'running').length }}
        </span>
        <span class="foot-sep">/</span>
        <span class="foot-stat">
          <span class="foot-dot dot-dead" />
          {{ agents.filter(a => a.status === 'dead').length }}
        </span>
        <span class="foot-sep">/</span>
        <span class="foot-stat total">{{ agents.length }} total</span>
      </div>
    </aside>

    <!-- RIGHT: Consciousness chat -->
    <section class="chat-panel">
      <div class="chat-head">
        <div class="chat-head-left">
          <span class="agent-sigil">FM</span>
          <div class="chat-head-info">
            <span class="chat-title">Consciousness</span>
            <span class="chat-sub">setup &amp; project onboarding</span>
          </div>
        </div>
        <div class="chat-head-right">
          <button
            v-if="messages.length > 0"
            class="icon-btn"
            title="New session"
            @click="clearSession"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 1.5A6.5 6.5 0 1 0 14.5 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M14.5 2v6h-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <div class="conn-status" :class="{ connected: isConnected }">
            <span class="conn-dot" />
            <span class="conn-label">{{ isConnected ? 'connected' : 'offline' }}</span>
          </div>
        </div>
      </div>

      <!-- Messages -->
      <div class="messages-wrap" ref="messagesEl">
        <div class="messages-inner">
          <div v-if="messages.length === 0" class="chat-empty">
            <div class="empty-sigil">FM</div>
            <div class="empty-text">Consciousness is ready.<br>How can I help you?</div>
          </div>

          <template v-for="(msg, i) in messages" :key="msg.id">
            <div
              class="msg-row"
              :class="[msg.role, msg.type, { 'grouped': isGrouped(i) }]"
            >
              <div
                class="msg-bubble"
                :class="[msg.role, msg.type]"
                @mouseenter="hoveredMsg = msg.id"
                @mouseleave="hoveredMsg = null"
              >
                <div v-if="msg.role === 'agent'" class="msg-content" v-html="renderMarkdown(msg.text)" />
                <div v-else class="msg-content user-text">{{ msg.text }}</div>
                <div class="msg-footer">
                  <span class="msg-ts">{{ formatTs(msg.ts) }}</span>
                  <button
                    v-if="msg.role === 'agent' && hoveredMsg === msg.id"
                    class="copy-btn"
                    :class="{ copied: copiedMsg === msg.id }"
                    @click="copyMessage(msg)"
                    title="Copy"
                  >
                    <svg v-if="copiedMsg !== msg.id" width="11" height="11" viewBox="0 0 16 16" fill="none">
                      <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
                      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                    <svg v-else width="11" height="11" viewBox="0 0 16 16" fill="none">
                      <path d="M2.5 8.5L6 12L13.5 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </template>

          <!-- Loading indicator -->
          <div v-if="loading_chat" class="msg-row agent">
            <div class="msg-bubble agent loading-bubble">
              <span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" />
              <span v-if="currentToolCall" class="tool-call-label">{{ currentToolCall }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Input -->
      <div class="input-area">
        <div class="chat-target">
          <label>Chat with:</label>
          <select v-model="chatAgent">
            <option value="">Consciousness (default)</option>
            <option v-for="a in agents.filter(a => a.status === 'running')" :key="a.agentId" :value="a.agentId">
              {{ a.agentId }}
            </option>
          </select>
        </div>
        <div class="input-wrap" :class="{ focused: inputFocused, disabled: loading_chat }">
          <textarea
            ref="inputEl"
            v-model="inputText"
            class="chat-input"
            placeholder="Type a message..."
            rows="1"
            @keydown.enter.exact.prevent="sendMessage"
            @keydown.enter.shift.exact="() => {}"
            @input="autoResize"
            @focus="inputFocused = true"
            @blur="inputFocused = false"
          />
          <button
            class="send-btn"
            :disabled="!inputText.trim()"
            @click="sendMessage"
            title="Send (Enter)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M14 8L2 2l2.5 6L2 14l12-6z" fill="currentColor"/>
            </svg>
          </button>
        </div>
        <div class="input-hint">
          <span>Enter to send</span>
          <span class="hint-sep">·</span>
          <span>Shift+Enter for newline</span>
        </div>
      </div>
    </section>

    <AgentModal v-if="selectedAgentId" :agentId="selectedAgentId" @close="selectedAgentId = null" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import AgentModal from '../../components/AgentModal.vue'
import WorkflowGraph from '../../components/WorkflowGraph.vue'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentState {
  agentId: string
  status: 'starting' | 'running' | 'dead' | 'restarting' | 'rolling-over'
  restartCount: number
  startedAt?: string
  lastHeartbeat?: string
  containerId?: string
  busy?: boolean
  task?: string
}

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  type?: 'error'
  text: string
  ts: number
}

// ── Refs ──────────────────────────────────────────────────────────────────────

const agents = ref<AgentState[]>([])
const loading = ref(true)
const selectedAgentId = ref<string | null>(null)

const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const loading_chat = ref(false)
const isConnected = ref(true)
const inputFocused = ref(false)
const hoveredMsg = ref<string | null>(null)
const copiedMsg = ref<string | null>(null)
const messagesEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const currentToolCall = ref<string | null>(null)
const chatAgent = ref('')  // empty = consciousness (default), or agentId

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

// Session ID persisted across page refreshes
const SESSION_KEY = 'settings-session-id'
const sessionId = ref(sessionStorage.getItem(SESSION_KEY) ?? uuid())
sessionStorage.setItem(SESSION_KEY, sessionId.value)

// ── Agent health polling ───────────────────────────────────────────────────────

async function loadHealth() {
  try {
    const res = await fetch('/api/health')
    const data = await res.json() as { agents?: AgentState[] }
    agents.value = Array.isArray(data.agents) ? data.agents : []
    isConnected.value = true
  } catch {
    isConnected.value = false
  } finally {
    loading.value = false
  }
}

let healthInterval: ReturnType<typeof setInterval>

// ── Chat ──────────────────────────────────────────────────────────────────────

function parseReply(reply: unknown): string {
  if (typeof reply === 'string') return reply
  if (reply && typeof reply === 'object') {
    const r = reply as Record<string, unknown>
    if (typeof r.content === 'string') return r.content
    if (typeof r.message === 'string') return r.message
    if (typeof r.text === 'string') return r.text
    if (typeof r.result === 'string' && r.result) return r.result
    // Empty result from agent — don't show raw JSON
    if ('result' in r && !r.result) return ''
    return JSON.stringify(reply, null, 2)
  }
  return String(reply ?? '')
}

async function sendMessage() {
  const text = inputText.value.trim()
  if (!text || loading_chat.value) return

  inputText.value = ''
  await nextTick()
  if (inputEl.value) {
    inputEl.value.style.height = 'auto'
  }

  messages.value.push({ id: uuid(), role: 'user', text, ts: Date.now() })
  loading_chat.value = true
  await scrollToBottom()

  // Streaming message placeholder — will be updated as chunks arrive
  const agentMsgId = uuid()
  let streamingMsg: ChatMessage | null = null

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        sessionId: sessionId.value,
        ...(chatAgent.value ? { agent: chatAgent.value } : {}),
      }),
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    const processLine = async (line: string) => {
      if (!line.startsWith('data: ')) return
      try {
        const event = JSON.parse(line.slice(6)) as { type: string; text?: string; error?: string; toolName?: string }

        if (event.type === 'tool_call') {
          currentToolCall.value = event.toolName ?? null
        } else if (event.type === 'chunk') {
          currentToolCall.value = null
          if (!streamingMsg) {
            messages.value.push({ id: agentMsgId, role: 'agent', text: '', ts: Date.now() })
            // Use the reactive proxy from the array, not the plain object
            streamingMsg = messages.value[messages.value.length - 1]
          }
          streamingMsg.text += event.text ?? ''
          // Yield to Vue so each chunk renders immediately rather than batching
          await nextTick()
          scrollToBottom()
        } else if (event.type === 'error') {
          loading_chat.value = false
          messages.value.push({ id: agentMsgId, role: 'agent', type: 'error', text: event.error ?? 'Error', ts: Date.now() })
        }
      } catch { /* ignore malformed lines */ }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) await processLine(line.trim())
    }
    // Process any remaining buffer
    if (buf.trim()) await processLine(buf.trim())

    isConnected.value = true
  } catch (err) {
    loading_chat.value = false
    messages.value.push({
      id: agentMsgId,
      role: 'agent',
      type: 'error',
      text: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
      ts: Date.now(),
    })
    isConnected.value = false
  } finally {
    loading_chat.value = false
    currentToolCall.value = null
    await scrollToBottom()
    await nextTick()
    inputEl.value?.focus()
  }
}

function clearSession() {
  messages.value = []
  const newId = uuid()
  sessionId.value = newId
  sessionStorage.setItem(SESSION_KEY, newId)
  nextTick(() => inputEl.value?.focus())
}

async function scrollToBottom(smooth = false) {
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTo({
      top: messagesEl.value.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    })
  }
}

function autoResize(e: Event) {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  const lineH = parseInt(getComputedStyle(el).lineHeight) || 20
  el.style.height = Math.min(el.scrollHeight, lineH * 4 + 16) + 'px'
}

function renderMarkdown(text: string): string {
  try {
    return DOMPurify.sanitize(marked.parse(text) as string)
  } catch {
    return DOMPurify.sanitize(text)
  }
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Group consecutive same-role messages (skip gap between them)
function isGrouped(i: number): boolean {
  if (i === 0) return false
  return messages.value[i].role === messages.value[i - 1].role
}

async function copyMessage(msg: ChatMessage) {
  try {
    await navigator.clipboard.writeText(msg.text)
    copiedMsg.value = msg.id
    setTimeout(() => { copiedMsg.value = null }, 1500)
  } catch { /* ignore */ }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(() => {
  loadHealth()
  healthInterval = setInterval(loadHealth, 3000)
  nextTick(() => inputEl.value?.focus())
})

onUnmounted(() => clearInterval(healthInterval))
</script>

<style scoped>
/* ── Layout ─────────────────────────────────────────────────────────────────── */

.workspace {
  display: grid;
  grid-template-columns: minmax(400px, 1fr) 1fr;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* ── Left panel ─────────────────────────────────────────────────────────────── */

.graph-panel {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  overflow: hidden;
  background: var(--bg);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.panel-title {
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--text-muted);
  font-weight: 600;
}

.count-badge {
  font-size: 11px;
  background: var(--surface2);
  color: var(--text-muted);
  padding: 1px 7px;
  border-radius: 10px;
  border: 1px solid var(--border);
}


.panel-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.foot-stat {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-muted);
}

.foot-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.foot-dot.dot-running { background: var(--accent2); }
.foot-dot.dot-dead    { background: var(--danger); }

.foot-sep { color: var(--border); font-size: 10px; }
.foot-stat.total { color: var(--text-muted); }

/* ── Right panel: chat ──────────────────────────────────────────────────────── */

.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

/* Chat header */
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--surface);
}

.chat-head-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.chat-head-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.agent-sigil {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  background: var(--surface2);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 1px;
  flex-shrink: 0;
}

.chat-head-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chat-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.chat-sub {
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.5px;
}

.icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 3px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.icon-btn:hover {
  color: var(--text);
  border-color: var(--text-muted);
  background: var(--surface2);
}

.conn-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.5px;
}

.conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border);
}

.conn-status.connected .conn-dot { background: var(--accent2); box-shadow: 0 0 4px var(--accent2); }
.conn-status.connected .conn-label { color: var(--accent2); }

/* Messages */
.messages-wrap {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
}

.messages-wrap::-webkit-scrollbar { width: 4px; }
.messages-wrap::-webkit-scrollbar-track { background: transparent; }
.messages-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.messages-inner {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 100%;
  justify-content: flex-end;
}

/* Empty state */
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 48px 24px;
  text-align: center;
}

.empty-sigil {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 1px;
}

.empty-text {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.6;
}

/* Message rows */
.msg-row {
  display: flex;
  animation: msg-in 0.18s ease-out both;
}
@keyframes msg-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

.msg-row.user  { justify-content: flex-end; }
.msg-row.agent { justify-content: flex-start; }

/* Grouped messages: reduce gap */
.msg-row.grouped { margin-top: -4px; }

.msg-bubble {
  max-width: 72%;
  padding: 10px 14px 8px;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.55;
  position: relative;
}

.msg-bubble.user {
  background: var(--accent);
  color: #0d1117;
  border-radius: 4px 4px 2px 4px;
}

.msg-bubble.agent {
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 4px 4px 4px 2px;
}

/* Error message */
.msg-bubble.agent.error {
  background: rgba(248, 81, 73, 0.08);
  border-color: rgba(248, 81, 73, 0.3);
  color: #ffa198;
}

.user-text { white-space: pre-wrap; word-break: break-word; }

/* Markdown rendering inside agent bubbles */
.msg-content :deep(p)           { margin: 0 0 8px; }
.msg-content :deep(p:last-child) { margin-bottom: 0; }
.msg-content :deep(code)         { background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: inherit; }
.msg-content :deep(pre)          { background: rgba(0,0,0,0.4); padding: 10px 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0; border: 1px solid rgba(255,255,255,0.06); }
.msg-content :deep(pre code)     { background: none; padding: 0; font-size: 12px; }
.msg-content :deep(ul),
.msg-content :deep(ol)           { padding-left: 18px; margin: 6px 0; }
.msg-content :deep(li)           { margin: 3px 0; }
.msg-content :deep(strong)       { color: var(--text); font-weight: 600; }
.msg-content :deep(a)            { color: var(--accent); text-decoration: none; border-bottom: 1px solid transparent; transition: border-color 0.1s; }
.msg-content :deep(a:hover)      { border-bottom-color: var(--accent); }
.msg-content :deep(h1),
.msg-content :deep(h2),
.msg-content :deep(h3)           { font-size: 13px; font-weight: 700; margin: 12px 0 4px; color: var(--accent); letter-spacing: 0.5px; }
.msg-content :deep(table)        { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
.msg-content :deep(th)           { background: rgba(0,0,0,0.3); padding: 5px 10px; border: 1px solid var(--border); text-align: left; font-weight: 600; }
.msg-content :deep(td)           { padding: 4px 10px; border: 1px solid var(--border); }
.msg-content :deep(blockquote)   { border-left: 2px solid var(--accent); padding-left: 12px; color: var(--text-muted); margin: 8px 0; font-style: italic; }
.msg-content :deep(hr)           { border: none; border-top: 1px solid var(--border); margin: 12px 0; }

/* Message footer: timestamp + copy */
.msg-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 5px;
}

.msg-ts {
  font-size: 9px;
  color: var(--text-muted);
  opacity: 0.55;
  line-height: 1;
}
.msg-bubble.user .msg-ts { color: rgba(13,17,23,0.45); }

.copy-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  opacity: 0.6;
  transition: opacity 0.1s, color 0.1s;
  line-height: 1;
}
.copy-btn:hover { opacity: 1; color: var(--text); }
.copy-btn.copied { color: var(--accent2); opacity: 1; }

/* Typing indicator */
.loading-bubble {
  padding: 12px 16px 10px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.tool-call-label {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: 6px;
  opacity: 0.7;
  font-style: italic;
}

.typing-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: typing 1.4s ease-in-out infinite;
}
.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing {
  0%,80%,100% { transform: scale(0.6); opacity: 0.35; }
  40%         { transform: scale(1);   opacity: 1; }
}

/* Input area */
.input-area {
  padding: 12px 24px 14px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--surface);
}

.chat-target {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
.chat-target label { font-weight: 500; }
.chat-target select {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--text);
}

.input-wrap {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px 8px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.input-wrap.focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.08);
}

.input-wrap.disabled {
  opacity: 0.6;
}

.chat-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: 13px;
  color: var(--text);
  line-height: 1.5;
  max-height: calc(1.5em * 4 + 16px);
  overflow-y: auto;
}
.chat-input::-webkit-scrollbar { width: 3px; }
.chat-input::-webkit-scrollbar-thumb { background: var(--border); }

.chat-input::placeholder { color: var(--text-muted); opacity: 0.45; }
.chat-input:disabled { cursor: not-allowed; }

.send-btn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 3px;
  background: var(--accent);
  border: none;
  color: #0d1117;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, opacity 0.15s;
}
.send-btn:hover:not(:disabled) { background: #79c0ff; }
.send-btn:disabled { opacity: 0.25; cursor: not-allowed; }

.input-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 9px;
  color: var(--text-muted);
  margin-top: 6px;
  opacity: 0.45;
  letter-spacing: 0.3px;
}
.hint-sep { opacity: 0.5; }

/* Blink cursor */
.blink { animation: blink 1s step-end infinite; }
@keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0; } }
</style>
