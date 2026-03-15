<template>
  <div class="chat-container">
    <div class="chat-header">
      <span class="chat-icon">💬</span>
      <h1>Chat</h1>
    </div>

    <div class="chat-messages" ref="messagesEl">
      <div v-if="messages.length === 0" class="chat-empty">
        <p>Začni konverzaci — napiš zprávu níže.</p>
      </div>
      <div
        v-for="(msg, idx) in messages"
        :key="idx"
        class="chat-message"
        :class="msg.role === 'user' ? 'chat-message--user' : 'chat-message--agent'"
      >
        <div class="chat-bubble">
          <span class="chat-role">{{ msg.role === 'user' ? 'Ty' : 'Agent' }}</span>
          <p class="chat-text">{{ msg.text }}</p>
        </div>
      </div>
      <div v-if="loading" class="chat-message chat-message--agent">
        <div class="chat-bubble">
          <span class="chat-role">Agent</span>
          <p class="chat-text chat-loading">
            <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
          </p>
        </div>
      </div>
    </div>

    <div class="chat-input-area">
      <input
        v-model="inputText"
        class="chat-input"
        type="text"
        placeholder="Napiš zprávu..."
        :disabled="loading"
        @keyup.enter="sendMessage"
      />
      <button class="chat-send-btn" :disabled="loading || !inputText.trim()" @click="sendMessage">
        Odeslat
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

interface Message {
  role: 'user' | 'agent'
  text: string
}

const STORAGE_KEY = 'simple-chat-session'

function loadSession(): { messages: Message[]; sessionId: string } {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { messages: [], sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
}

const saved = loadSession()
const messages = ref<Message[]>(saved.messages)
const sessionId = saved.sessionId
const inputText = ref('')
const loading = ref(false)
const messagesEl = ref<HTMLElement | null>(null)

watch(messages, (val) => {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: val, sessionId }))
}, { deep: true })

async function scrollToBottom() {
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
}

async function sendMessage() {
  const text = inputText.value.trim()
  if (!text || loading.value) return

  messages.value.push({ role: 'user', text })
  inputText.value = ''
  loading.value = true
  await scrollToBottom()

  try {
    const res = await fetch('/api/chat/simple-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      messages.value.push({ role: 'agent', text: `Chyba: ${err.error ?? res.statusText}` })
    } else {
      const data = await res.json() as { reply: unknown }
      const replyText = typeof data.reply === 'string'
        ? data.reply
        : JSON.stringify(data.reply)
      messages.value.push({ role: 'agent', text: replyText })
    }
  } catch (err) {
    messages.value.push({ role: 'agent', text: `Síťová chyba: ${String(err)}` })
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}
</script>

<style scoped>
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-width: 800px;
  margin: 0 auto;
  padding: 1rem;
  box-sizing: border-box;
}

.chat-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid #e5e7eb;
}

.chat-icon {
  font-size: 1.5rem;
}

.chat-header h1 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: #111827;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 0;
}

.chat-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #9ca3af;
  font-size: 0.95rem;
}

.chat-message {
  display: flex;
}

.chat-message--user {
  justify-content: flex-end;
}

.chat-message--agent {
  justify-content: flex-start;
}

.chat-bubble {
  max-width: 70%;
  padding: 0.6rem 0.9rem;
  border-radius: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.chat-message--user .chat-bubble {
  background-color: #3b82f6;
  color: #fff;
  border-bottom-right-radius: 0.25rem;
}

.chat-message--agent .chat-bubble {
  background-color: #f3f4f6;
  color: #111827;
  border-bottom-left-radius: 0.25rem;
}

.chat-role {
  font-size: 0.7rem;
  font-weight: 600;
  opacity: 0.65;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.chat-text {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-loading {
  display: flex;
  gap: 0.15rem;
}

.dot {
  animation: blink 1.2s infinite;
  font-size: 1.2rem;
  line-height: 1;
}

.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
}

.chat-input-area {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid #e5e7eb;
}

.chat-input {
  flex: 1;
  padding: 0.6rem 0.9rem;
  border: 1px solid #d1d5db;
  border-radius: 0.5rem;
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.15s;
}

.chat-input:focus {
  border-color: #3b82f6;
}

.chat-input:disabled {
  background-color: #f9fafb;
  cursor: not-allowed;
}

.chat-send-btn {
  padding: 0.6rem 1.2rem;
  background-color: #3b82f6;
  color: #fff;
  border: none;
  border-radius: 0.5rem;
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.15s;
}

.chat-send-btn:hover:not(:disabled) {
  background-color: #2563eb;
}

.chat-send-btn:disabled {
  background-color: #93c5fd;
  cursor: not-allowed;
}
</style>
