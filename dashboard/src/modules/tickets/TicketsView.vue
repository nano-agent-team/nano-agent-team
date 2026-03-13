<template>
  <div class="tickets-root">
    <div class="layout">
      <!-- List panel -->
      <div class="list-panel">
        <div class="filters">
          <input v-model="search" class="search-input" placeholder="🔍 Hledat..." autocomplete="off" />
          <select v-model="filterStatus" class="filter-select">
            <option value="">Vše (status)</option>
            <option value="idea">idea</option>
            <option value="approved">approved</option>
            <option value="in_progress">in_progress</option>
            <option value="review">review</option>
            <option value="done">done</option>
            <option value="rejected">rejected</option>
          </select>
          <select v-model="filterPriority" class="filter-select">
            <option value="">Vše (priorita)</option>
            <option value="CRITICAL">CRITICAL</option>
            <option value="HIGH">HIGH</option>
            <option value="MED">MED</option>
            <option value="LOW">LOW</option>
          </select>
        </div>
        <div class="list-header">
          <span>{{ filteredTickets.length }} ticketů</span>
          <button class="btn-refresh" @click="loadTickets">↻</button>
        </div>
        <ul class="ticket-list">
          <li
            v-for="t in filteredTickets"
            :key="t.id"
            :class="['ticket-item', selectedId === t.id ? 'active' : '']"
            @click="selectTicket(t)"
          >
            <div class="ti-header">
              <span class="ti-id">{{ t.id }}</span>
              <span :class="`badge badge-${t.status}`">{{ t.status }}</span>
              <span v-if="t.priority" :class="`badge badge-pri-${t.priority}`">{{ t.priority }}</span>
            </div>
            <div class="ti-title">{{ t.title }}</div>
            <div class="ti-meta">
              <span v-if="t.assigned_to">{{ t.assigned_to }}</span>
              <span v-if="t.updated_at" class="ti-date">{{ relTime(t.updated_at) }}</span>
            </div>
          </li>
        </ul>
        <!-- New ticket form -->
        <div class="new-ticket-form">
          <input
            v-model="newTitle"
            class="new-ticket-input"
            placeholder="+ Nový ticket..."
            @keyup.enter="createTicket"
          />
          <button class="btn-create" :disabled="!newTitle.trim()" @click="createTicket">Vytvořit</button>
        </div>
      </div>

      <!-- Detail panel -->
      <div class="detail-panel">
        <div v-if="!selected" class="detail-empty">
          <div style="font-size:40px;opacity:0.2">📋</div>
          <div>Vyberte ticket ze seznamu</div>
        </div>

        <div v-else class="detail-content">
          <div class="detail-header">
            <div class="detail-id">{{ selected.id }}</div>
            <div class="detail-badges">
              <span :class="`badge badge-${selected.status}`">{{ selected.status }}</span>
              <span v-if="selected.priority" :class="`badge badge-pri-${selected.priority}`">{{ selected.priority }}</span>
            </div>
          </div>
          <h2 class="detail-title">{{ selected.title }}</h2>
          <div class="detail-meta">
            <span v-if="selected.assigned_to">Agent: {{ selected.assigned_to }}</span>
            <span v-if="selected.created_at">Vytvořeno: {{ relTime(selected.created_at) }}</span>
            <span v-if="selected.updated_at">Aktualizováno: {{ relTime(selected.updated_at) }}</span>
          </div>

          <div v-if="selected.body" class="detail-section">
            <div class="section-label">POPIS / SPEC</div>
            <div class="markdown-body" v-html="renderMarkdown(selected.body)"></div>
          </div>

          <!-- Comments -->
          <div class="detail-section">
            <div class="section-label">KOMENTÁŘE</div>
            <div v-for="c in comments" :key="c.id" class="comment">
              <div class="comment-header">
                <span class="comment-author">{{ c.author || 'Agent' }}</span>
                <span class="comment-time">{{ relTime(c.created_at) }}</span>
              </div>
              <div class="comment-body">{{ c.body }}</div>
            </div>
            <div v-if="comments.length === 0" style="color:#8b949e;font-size:12px">Žádné komentáře</div>
          </div>

          <!-- Add comment -->
          <div class="comment-form">
            <textarea
              v-model="newComment"
              placeholder="Přidat komentář..."
              class="comment-textarea"
              rows="3"
            ></textarea>
            <button class="btn-comment" :disabled="!newComment.trim()" @click="addComment">Přidat komentář</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { marked } from 'marked'
import { relTime } from '../../utils/time'

interface Ticket {
  id: string
  title: string
  status: string
  priority?: string
  assigned_to?: string
  body?: string
  created_at?: string
  updated_at?: string
}

interface Comment {
  id: number
  author?: string
  body: string
  created_at?: string
}

const tickets = ref<Ticket[]>([])
const selected = ref<Ticket | null>(null)
const selectedId = ref<string | null>(null)
const comments = ref<Comment[]>([])
const newComment = ref('')
const newTitle = ref('')
const search = ref('')
const filterStatus = ref('')
const filterPriority = ref('')

// Handle ?q= URL param
const urlQ = new URLSearchParams(window.location.search).get('q')
if (urlQ) search.value = urlQ

const filteredTickets = computed(() => {
  let list = tickets.value
  if (filterStatus.value) list = list.filter(t => t.status === filterStatus.value)
  if (filterPriority.value) list = list.filter(t => t.priority === filterPriority.value)
  if (search.value) {
    const q = search.value.toLowerCase()
    list = list.filter(t =>
      t.id.toLowerCase().includes(q) ||
      t.title.toLowerCase().includes(q) ||
      (t.assigned_to?.toLowerCase().includes(q) ?? false)
    )
  }
  return list
})

function renderMarkdown(md: string): string {
  try {
    return marked.parse(md) as string
  } catch {
    return md
  }
}

async function loadTickets() {
  try {
    const res = await fetch('/api/tickets')
    tickets.value = await res.json()
    if (urlQ && !selected.value) {
      const found = tickets.value.find(t => t.id === urlQ || t.id.toLowerCase() === urlQ.toLowerCase())
      if (found) selectTicket(found)
    }
  } catch (e) {
    console.error('loadTickets error', e)
  }
}

async function selectTicket(t: Ticket) {
  selected.value = t
  selectedId.value = t.id
  await loadComments(t.id)
}

async function loadComments(ticketId: string) {
  try {
    const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/comments`)
    if (res.ok) comments.value = await res.json()
    else comments.value = []
  } catch {
    comments.value = []
  }
}

async function addComment() {
  if (!selected.value || !newComment.value.trim()) return
  try {
    const res = await fetch(`/api/tickets/${encodeURIComponent(selected.value.id)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: newComment.value.trim() })
    })
    if (res.ok) {
      newComment.value = ''
      await loadComments(selected.value.id)
    }
  } catch (e) {
    console.error('addComment error', e)
  }
}

async function createTicket() {
  if (!newTitle.value.trim()) return
  try {
    const res = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.value.trim(), status: 'idea' })
    })
    if (res.ok) {
      const ticket = await res.json()
      newTitle.value = ''
      await loadTickets()
      selectTicket(ticket)
    }
  } catch (e) {
    console.error('createTicket error', e)
  }
}

// SSE for real-time updates
let evtSource: EventSource | null = null

function connectSSE() {
  evtSource = new EventSource('/api/events')
  evtSource.addEventListener('ticket:created', () => { void loadTickets() })
  evtSource.addEventListener('ticket:updated', () => { void loadTickets() })
  evtSource.onerror = () => {
    evtSource?.close()
    setTimeout(connectSSE, 5000)
  }
}

let pollInterval: ReturnType<typeof setInterval>

onMounted(() => {
  loadTickets()
  pollInterval = setInterval(loadTickets, 30000)
  connectSSE()
})

onUnmounted(() => {
  clearInterval(pollInterval)
  evtSource?.close()
})
</script>

<style scoped>
.tickets-root {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 40px);
}

.layout { display: flex; flex: 1; overflow: hidden; }

.list-panel {
  width: 55%;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-panel { flex: 1; overflow-y: auto; padding: 20px; }

.filters {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.search-input, .filter-select {
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
}
.search-input { flex: 1; min-width: 120px; }
.search-input:focus, .filter-select:focus { border-color: var(--accent); }

.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.btn-refresh {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
}
.btn-refresh:hover { color: var(--text); }

.ticket-list { list-style: none; overflow-y: auto; flex: 1; }
.ticket-item {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.1s;
}
.ticket-item:hover { background: var(--surface); }
.ticket-item.active { background: #1f3a5e; border-left: 3px solid var(--accent); }

.ti-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.ti-id { font-size: 11px; color: var(--accent); font-weight: 600; }
.ti-title { font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ti-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-top: 4px; }

.badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; }
.badge-idea { background: rgba(188, 140, 255, 0.15); color: #bc8cff; }
.badge-approved { background: rgba(88, 166, 255, 0.15); color: #58a6ff; }
.badge-in_progress { background: rgba(63, 185, 80, 0.15); color: #3fb950; }
.badge-review { background: rgba(210, 153, 34, 0.15); color: #d29922; }
.badge-done { background: rgba(63, 185, 80, 0.1); color: #3fb950; }
.badge-rejected { background: rgba(248, 81, 73, 0.15); color: #f85149; }
.badge-pri-CRITICAL { background: rgba(248, 81, 73, 0.15); color: #f85149; }
.badge-pri-HIGH { background: rgba(240, 136, 62, 0.15); color: #f0883e; }
.badge-pri-MED { background: rgba(88, 166, 255, 0.12); color: #58a6ff; }
.badge-pri-LOW { background: rgba(139, 148, 158, 0.1); color: #8b949e; }

.new-ticket-form {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}
.new-ticket-input {
  flex: 1;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
}
.new-ticket-input:focus { border-color: var(--accent); }
.btn-create {
  background: var(--accent);
  border: none;
  color: #000;
  padding: 5px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  font-weight: 600;
}
.btn-create:disabled { opacity: 0.4; cursor: not-allowed; }

.detail-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 200px; color: var(--text-muted); gap: 12px; font-size: 14px; }
.detail-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.detail-id { font-size: 13px; color: var(--accent); font-weight: 700; }
.detail-title { font-size: 18px; color: var(--text); margin-bottom: 10px; line-height: 1.4; }
.detail-meta { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); margin-bottom: 16px; flex-wrap: wrap; }
.detail-section { margin-bottom: 20px; }
.section-label { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; }

.markdown-body { font-size: 13px; color: var(--text); line-height: 1.6; }
:deep(.markdown-body) h1, :deep(.markdown-body) h2, :deep(.markdown-body) h3 { color: var(--text); margin: 12px 0 6px; }
:deep(.markdown-body) p { margin-bottom: 8px; }
:deep(.markdown-body) code { background: var(--surface2); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
:deep(.markdown-body) pre { background: var(--surface2); padding: 12px; border-radius: 4px; overflow-x: auto; margin-bottom: 8px; }
:deep(.markdown-body) ul, :deep(.markdown-body) ol { margin-left: 20px; margin-bottom: 8px; }

.comment { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
.comment-header { display: flex; justify-content: space-between; margin-bottom: 6px; }
.comment-author { font-size: 12px; color: var(--accent); font-weight: 600; }
.comment-time { font-size: 11px; color: var(--text-muted); }
.comment-body { font-size: 13px; color: var(--text); white-space: pre-wrap; }

.comment-form { margin-top: 16px; }
.comment-textarea { width: 100%; background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 8px; border-radius: 4px; font-family: inherit; font-size: 12px; resize: vertical; outline: none; }
.comment-textarea:focus { border-color: var(--accent); }
.btn-comment { margin-top: 6px; background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: inherit; }
.btn-comment:hover { background: var(--border); }
.btn-comment:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
