<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { fetchThreads, fetchMessages, sendMessage, createThread } from './SoulApiClient';
import type { ChatThread, ChatMessage } from './SoulApiClient';

const minimized = ref(true);
const threads = ref<ChatThread[]>([]);
const activeThread = ref('main');
const messages = ref<ChatMessage[]>([]);
const inputText = ref('');
const sending = ref(false);
const messagesEl = ref<HTMLElement | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;

const pendingCount = computed(() =>
  threads.value.filter((t) => t.pending).length,
);

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  }
}

async function loadThreads(): Promise<void> {
  threads.value = await fetchThreads();
  if (threads.value.length > 0 && !threads.value.find((t) => t.id === activeThread.value)) {
    activeThread.value = threads.value[0].id;
  }
}

async function loadMessages(): Promise<void> {
  messages.value = await fetchMessages(activeThread.value);
  await scrollToBottom();
}

async function send(): Promise<void> {
  const text = inputText.value.trim();
  if (!text || sending.value) return;

  const userMsg: ChatMessage = { role: 'user', text, ts: Date.now() };
  messages.value = [...messages.value, userMsg];
  inputText.value = '';
  sending.value = true;
  await scrollToBottom();

  try {
    const reply = await sendMessage(activeThread.value, text);
    if (reply) {
      const agentMsg: ChatMessage = { role: 'agent', text: reply, ts: Date.now() };
      messages.value = [...messages.value, agentMsg];
    }
  } finally {
    sending.value = false;
    await scrollToBottom();
  }
}

async function addThread(): Promise<void> {
  const title = `Thread ${threads.value.length + 1}`;
  const created = await createThread(title);
  if (created) {
    threads.value = [...threads.value, created];
    activeThread.value = created.id;
  }
}

watch(activeThread, () => {
  loadMessages();
});

onMounted(async () => {
  await loadThreads();
  await loadMessages();
  pollTimer = setInterval(loadThreads, 5000);
});

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<template>
  <!-- Minimized: bubble -->
  <div v-if="minimized" class="chat-bubble" @click="minimized = false">
    💬
    <span v-if="pendingCount > 0" class="badge">{{ pendingCount }}</span>
  </div>

  <!-- Expanded: full panel -->
  <div v-else class="chat-panel">
    <!-- Header with tabs -->
    <div class="chat-header">
      <div class="chat-tabs">
        <div
          v-for="t in threads"
          :key="t.id"
          class="chat-tab"
          :class="{ active: activeThread === t.id }"
          @click="activeThread = t.id"
        >
          {{ t.title }}
          <span v-if="t.pending" class="tab-badge"></span>
        </div>
        <div class="chat-tab add-tab" @click="addThread">+</div>
      </div>
      <button class="minimize-btn" @click="minimized = true">▼</button>
    </div>

    <!-- Messages -->
    <div ref="messagesEl" class="chat-messages">
      <div
        v-for="msg in messages"
        :key="msg.ts"
        class="chat-msg"
        :class="msg.role"
      >
        <div class="msg-text">{{ msg.text }}</div>
        <div class="msg-time">{{ formatTime(msg.ts) }}</div>
      </div>
      <div v-if="sending" class="chat-msg agent typing">
        <div class="msg-text">...</div>
      </div>
    </div>

    <!-- Input -->
    <div class="chat-input">
      <input
        v-model="inputText"
        placeholder="Napiste zpravu..."
        :disabled="sending"
        @keydown.enter="send"
      />
      <button :disabled="!inputText.trim() || sending" @click="send">➤</button>
    </div>
  </div>
</template>

<style scoped>
/* ── Bubble ──────────────────────────────────────────────────── */
.chat-bubble {
  position: fixed;
  bottom: 16px;
  right: 16px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #7c3aed;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 22px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  z-index: 50;
  user-select: none;
}

.chat-bubble .badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: #ef4444;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

/* ── Panel ───────────────────────────────────────────────────── */
.chat-panel {
  position: fixed;
  bottom: 16px;
  right: 16px;
  width: 360px;
  height: 480px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  z-index: 50;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* ── Header / Tabs ───────────────────────────────────────────── */
.chat-header {
  display: flex;
  align-items: center;
  border-bottom: 1px solid #334155;
  background: #0f172a;
  min-height: 38px;
}

.chat-tabs {
  display: flex;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: none;
}

.chat-tabs::-webkit-scrollbar {
  display: none;
}

.chat-tab {
  position: relative;
  padding: 8px 14px;
  font-size: 12px;
  color: #94a3b8;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.chat-tab:hover {
  color: #e2e8f0;
}

.chat-tab.active {
  color: #e2e8f0;
  border-bottom-color: #7c3aed;
}

.chat-tab.add-tab {
  color: #64748b;
  font-weight: 700;
  font-size: 14px;
}

.chat-tab.add-tab:hover {
  color: #7c3aed;
}

.tab-badge {
  position: absolute;
  top: 6px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ef4444;
}

.minimize-btn {
  background: none;
  border: none;
  color: #64748b;
  font-size: 14px;
  cursor: pointer;
  padding: 8px 10px;
  transition: color 0.15s;
}

.minimize-btn:hover {
  color: #e2e8f0;
}

/* ── Messages ────────────────────────────────────────────────── */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chat-messages::-webkit-scrollbar {
  width: 4px;
}

.chat-messages::-webkit-scrollbar-track {
  background: transparent;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: #334155;
  border-radius: 2px;
}

.chat-msg {
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.4;
}

.chat-msg.user {
  align-self: flex-end;
  background: #4c1d95;
  color: #e2e8f0;
}

.chat-msg.agent {
  align-self: flex-start;
  background: #334155;
  color: #e2e8f0;
}

.chat-msg.typing {
  opacity: 0.6;
}

.msg-text {
  word-break: break-word;
}

.msg-time {
  font-size: 10px;
  color: #64748b;
  margin-top: 4px;
}

.chat-msg.user .msg-time {
  text-align: right;
}

/* ── Input ───────────────────────────────────────────────────── */
.chat-input {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid #334155;
  background: #0f172a;
}

.chat-input input {
  flex: 1;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 8px;
  padding: 8px 12px;
  color: #e2e8f0;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}

.chat-input input::placeholder {
  color: #64748b;
}

.chat-input input:focus {
  border-color: #7c3aed;
}

.chat-input input:disabled {
  opacity: 0.5;
}

.chat-input button {
  background: #7c3aed;
  border: none;
  border-radius: 8px;
  color: #fff;
  font-size: 16px;
  width: 36px;
  cursor: pointer;
  transition: background 0.15s;
}

.chat-input button:hover:not(:disabled) {
  background: #6d28d9;
}

.chat-input button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
