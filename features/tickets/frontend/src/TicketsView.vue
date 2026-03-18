<template>
  <div class="tickets-root">
    <header class="tickets-header">
      <h1 class="tickets-title">Tickets</h1>
      <button class="btn-primary" @click="openNewTicketModal">+ New Ticket</button>
    </header>

    <!-- Loading / Error -->
    <div v-if="loading" class="state-msg">Loading tickets…</div>
    <div v-else-if="error" class="state-msg error">{{ error }}</div>

    <!-- Kanban board -->
    <div v-else class="kanban-wrapper">
      <div class="kanban-board">
        <div
          v-for="col in columns"
          :key="col.status"
          class="kanban-column"
        >
          <div class="column-header" :style="{ borderTopColor: col.color }">
            <span class="column-title">{{ col.label }}</span>
            <span class="column-count">{{ ticketsByStatus(col.status).length }}</span>
          </div>
          <div class="column-body">
            <div
              v-for="ticket in ticketsByStatus(col.status)"
              :key="ticket.id"
              class="ticket-card"
              @click="selectTicket(ticket)"
              :class="{ selected: selectedTicket?.id === ticket.id }"
            >
              <div class="card-top">
                <span class="priority-badge" :class="'priority-' + ticket.priority.toLowerCase()">
                  {{ ticket.priority }}
                </span>
                <span class="ticket-id">#{{ ticket.id }}</span>
              </div>
              <div class="card-title">{{ ticket.title }}</div>
              <div v-if="ticket.assigned_to" class="card-assignee">
                <span class="assignee-icon">👤</span> {{ ticket.assigned_to }}
              </div>
            </div>
            <div v-if="ticketsByStatus(col.status).length === 0" class="empty-col">
              No tickets
            </div>
          </div>
        </div>
      </div>

      <!-- Rejected section (collapsed) -->
      <div class="rejected-section">
        <button class="rejected-toggle" @click="showRejected = !showRejected">
          <span>Rejected ({{ ticketsByStatus('rejected').length }})</span>
          <span>{{ showRejected ? '▲' : '▼' }}</span>
        </button>
        <div v-if="showRejected" class="rejected-cards">
          <div
            v-for="ticket in ticketsByStatus('rejected')"
            :key="ticket.id"
            class="ticket-card rejected"
            @click="selectTicket(ticket)"
            :class="{ selected: selectedTicket?.id === ticket.id }"
          >
            <div class="card-top">
              <span class="priority-badge" :class="'priority-' + ticket.priority.toLowerCase()">
                {{ ticket.priority }}
              </span>
              <span class="ticket-id">#{{ ticket.id }}</span>
            </div>
            <div class="card-title">{{ ticket.title }}</div>
          </div>
          <div v-if="ticketsByStatus('rejected').length === 0" class="empty-col">No rejected tickets</div>
        </div>
      </div>
    </div>

    <!-- Detail Panel -->
    <Transition name="panel-slide">
      <div v-if="selectedTicket" class="detail-overlay" @click.self="selectedTicket = null">
        <div class="detail-panel">
          <button class="panel-close" @click="selectedTicket = null">✕</button>

          <div class="panel-header">
            <span class="priority-badge lg" :class="'priority-' + selectedTicket.priority.toLowerCase()">
              {{ selectedTicket.priority }}
            </span>
            <h2 class="panel-title">{{ selectedTicket.title }}</h2>
          </div>

          <div class="panel-meta">
            <div class="meta-row">
              <span class="meta-label">ID</span>
              <span class="meta-value">#{{ selectedTicket.id }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Status</span>
              <span class="status-chip" :class="'status-' + selectedTicket.status">
                {{ statusLabel(selectedTicket.status) }}
              </span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Type</span>
              <span class="meta-value">{{ selectedTicket.type || '—' }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Assignee</span>
              <span class="meta-value">{{ selectedTicket.assigned_to || 'Unassigned' }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Created</span>
              <span class="meta-value">{{ formatDate(selectedTicket.created_at) }}</span>
            </div>
          </div>

          <!-- Transitions -->
          <div class="panel-transitions">
            <div class="transitions-label">Actions</div>
            <div v-if="selectedTicket.status === 'done'" class="completed-badge">✓ Completed</div>
            <div v-else class="transition-buttons">
              <template v-if="selectedTicket.status === 'new'">
                <button class="btn-action approve" @click="transition('approved')" :disabled="transitioning">Approve</button>
                <button class="btn-action reject" @click="transition('rejected')" :disabled="transitioning">Reject</button>
              </template>
              <template v-else-if="selectedTicket.status === 'approved'">
                <button class="btn-action start" @click="transition('in_progress')" :disabled="transitioning">Start Work</button>
                <button class="btn-action reject" @click="transition('rejected')" :disabled="transitioning">Reject</button>
              </template>
              <template v-else-if="selectedTicket.status === 'in_progress'">
                <button class="btn-action review" @click="transition('review')" :disabled="transitioning">Send to Review</button>
                <button class="btn-action reject" @click="transition('rejected')" :disabled="transitioning">Reject</button>
              </template>
              <template v-else-if="selectedTicket.status === 'review'">
                <button class="btn-action done" @click="transition('done')" :disabled="transitioning">Mark Done</button>
                <button class="btn-action back" @click="transition('in_progress')" :disabled="transitioning">Back to In Progress</button>
                <button class="btn-action reject" @click="transition('rejected')" :disabled="transitioning">Reject</button>
              </template>
              <template v-else-if="selectedTicket.status === 'rejected'">
                <button class="btn-action reopen" @click="transition('new')" :disabled="transitioning">Reopen</button>
              </template>
            </div>
            <div v-if="transitionError" class="transition-error">{{ transitionError }}</div>
          </div>

          <!-- Comment form -->
          <div class="panel-comment">
            <div class="transitions-label">Add Comment</div>
            <textarea
              v-model="commentText"
              class="comment-input"
              placeholder="Write a comment…"
              rows="3"
            ></textarea>
            <button
              class="btn-primary sm"
              @click="submitComment"
              :disabled="!commentText.trim() || submittingComment"
            >
              {{ submittingComment ? 'Posting…' : 'Post Comment' }}
            </button>
            <div v-if="commentError" class="transition-error">{{ commentError }}</div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- New Ticket Modal -->
    <Transition name="fade">
      <div v-if="showNewTicketModal" class="modal-overlay" @click.self="showNewTicketModal = false">
        <div class="modal">
          <div class="modal-header">
            <h3>New Ticket</h3>
            <button class="panel-close" @click="showNewTicketModal = false">✕</button>
          </div>
          <form @submit.prevent="createTicket" class="ticket-form">
            <div class="form-field">
              <label>Title <span class="required">*</span></label>
              <input
                v-model="newTicket.title"
                type="text"
                class="form-input"
                placeholder="Describe the ticket…"
                autofocus
              />
            </div>
            <div class="form-field">
              <label>Priority</label>
              <select v-model="newTicket.priority" class="form-select">
                <option value="LOW">LOW</option>
                <option value="MED">MED</option>
                <option value="HIGH">HIGH</option>
                <option value="CRITICAL">CRITICAL</option>
              </select>
            </div>
            <div class="form-field">
              <label>Type</label>
              <select v-model="newTicket.type" class="form-select">
                <option value="feature">Feature</option>
                <option value="bug">Bug</option>
                <option value="task">Task</option>
                <option value="improvement">Improvement</option>
              </select>
            </div>
            <div v-if="createError" class="transition-error">{{ createError }}</div>
            <div class="form-actions">
              <button type="button" class="btn-secondary" @click="showNewTicketModal = false">Cancel</button>
              <button type="submit" class="btn-primary" :disabled="!newTicket.title.trim() || creating">
                {{ creating ? 'Creating…' : 'Create Ticket' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Ticket {
  id: number | string
  title: string
  status: string
  priority: string
  type?: string
  assigned_to?: string
  created_at: string
}

interface Column {
  status: string
  label: string
  color: string
}

// ─── State ────────────────────────────────────────────────────────────────────

const tickets = ref<Ticket[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const selectedTicket = ref<Ticket | null>(null)
const transitioning = ref(false)
const transitionError = ref<string | null>(null)

const showRejected = ref(false)

const commentText = ref('')
const submittingComment = ref(false)
const commentError = ref<string | null>(null)

const showNewTicketModal = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)
const newTicket = ref({ title: '', priority: 'MED', type: 'task' })

let sseSource: EventSource | null = null

// ─── Columns definition ───────────────────────────────────────────────────────

const columns: Column[] = [
  { status: 'new',         label: 'New (Idea)',    color: '#6b7280' },
  { status: 'approved',    label: 'Approved',      color: '#3b82f6' },
  { status: 'in_progress', label: 'In Progress',   color: '#f59e0b' },
  { status: 'review',      label: 'Review',        color: '#8b5cf6' },
  { status: 'done',        label: 'Done',          color: '#10b981' },
]

// ─── Computed ─────────────────────────────────────────────────────────────────

function ticketsByStatus(status: string): Ticket[] {
  return tickets.value.filter(t => t.status === status)
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    new: 'New',
    approved: 'Approved',
    in_progress: 'In Progress',
    review: 'Review',
    done: 'Done',
    rejected: 'Rejected',
  }
  return map[status] ?? status
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchTickets() {
  try {
    const res = await fetch('/api/tickets')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    tickets.value = await res.json()
  } catch (e: any) {
    error.value = e.message ?? 'Failed to load tickets'
  } finally {
    loading.value = false
  }
}

async function transition(newStatus: string) {
  if (!selectedTicket.value) return
  transitioning.value = true
  transitionError.value = null
  try {
    const res = await fetch(`/api/tickets/${selectedTicket.value.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.error ?? `HTTP ${res.status}`)
    }
    const updated: Ticket = await res.json()
    // Update in list
    const idx = tickets.value.findIndex(t => t.id === updated.id)
    if (idx !== -1) tickets.value[idx] = updated
    selectedTicket.value = updated
  } catch (e: any) {
    transitionError.value = e.message ?? 'Transition failed'
  } finally {
    transitioning.value = false
  }
}

async function submitComment() {
  if (!selectedTicket.value || !commentText.value.trim()) return
  submittingComment.value = true
  commentError.value = null
  try {
    const res = await fetch(`/api/tickets/${selectedTicket.value.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: commentText.value.trim() }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.error ?? `HTTP ${res.status}`)
    }
    commentText.value = ''
  } catch (e: any) {
    commentError.value = e.message ?? 'Failed to post comment'
  } finally {
    submittingComment.value = false
  }
}

function openNewTicketModal() {
  newTicket.value = { title: '', priority: 'MED', type: 'task' }
  createError.value = null
  showNewTicketModal.value = true
}

async function createTicket() {
  if (!newTicket.value.title.trim()) return
  creating.value = true
  createError.value = null
  try {
    const res = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newTicket.value.title.trim(),
        priority: newTicket.value.priority,
        type: newTicket.value.type,
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.error ?? `HTTP ${res.status}`)
    }
    const created: Ticket = await res.json()
    tickets.value.unshift(created)
    showNewTicketModal.value = false
  } catch (e: any) {
    createError.value = e.message ?? 'Failed to create ticket'
  } finally {
    creating.value = false
  }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────

function connectSSE() {
  sseSource = new EventSource('/api/events')
  sseSource.addEventListener('ticket_created', (e: MessageEvent) => {
    try {
      const ticket: Ticket = JSON.parse(e.data)
      if (!tickets.value.find(t => t.id === ticket.id)) {
        tickets.value.unshift(ticket)
      }
    } catch { /* ignore parse errors */ }
  })
  sseSource.addEventListener('ticket_updated', (e: MessageEvent) => {
    try {
      const ticket: Ticket = JSON.parse(e.data)
      const idx = tickets.value.findIndex(t => t.id === ticket.id)
      if (idx !== -1) {
        tickets.value[idx] = ticket
        if (selectedTicket.value?.id === ticket.id) {
          selectedTicket.value = ticket
        }
      } else {
        tickets.value.unshift(ticket)
      }
    } catch { /* ignore parse errors */ }
  })
  sseSource.onerror = () => {
    // Reconnect after 5s
    setTimeout(() => {
      if (sseSource) {
        sseSource.close()
        connectSSE()
      }
    }, 5000)
  }
}

function selectTicket(ticket: Ticket) {
  selectedTicket.value = ticket
  transitionError.value = null
  commentText.value = ''
  commentError.value = null
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
  fetchTickets()
  connectSSE()
})

onUnmounted(() => {
  sseSource?.close()
  sseSource = null
})
</script>

<style scoped>
/* ── Root ── */
.tickets-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0f1117;
  color: #e2e8f0;
  font-family: system-ui, -apple-system, sans-serif;
  overflow: hidden;
}

/* ── Header ── */
.tickets-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 16px;
  border-bottom: 1px solid #2d3148;
  flex-shrink: 0;
}

.tickets-title {
  font-size: 1.4rem;
  font-weight: 600;
  margin: 0;
  color: #f1f5f9;
}

/* ── State messages ── */
.state-msg {
  padding: 40px;
  text-align: center;
  color: #64748b;
  font-size: 0.95rem;
}
.state-msg.error { color: #f87171; }

/* ── Kanban ── */
.kanban-wrapper {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 16px 24px 0;
  gap: 16px;
}

.kanban-board {
  display: flex;
  gap: 12px;
  flex: 1;
  overflow-x: auto;
  padding-bottom: 16px;
}

.kanban-column {
  min-width: 220px;
  max-width: 260px;
  flex: 1;
  background: #12151f;
  border-radius: 10px;
  border: 1px solid #1e2235;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 3px solid #6b7280;
  background: #161926;
  flex-shrink: 0;
}

.column-title {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
}

.column-count {
  background: #1e2235;
  color: #64748b;
  border-radius: 12px;
  padding: 1px 8px;
  font-size: 0.75rem;
  font-weight: 600;
}

.column-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── Ticket card ── */
.ticket-card {
  background: #1a1d2e;
  border: 1px solid #2d3148;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.ticket-card:hover {
  border-color: #4a5568;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.ticket-card.selected {
  border-color: #6366f1;
  box-shadow: 0 0 0 1px #6366f1;
}

.ticket-card.rejected {
  opacity: 0.65;
}

.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.ticket-id {
  font-size: 0.7rem;
  color: #475569;
  font-family: monospace;
}

.card-title {
  font-size: 0.85rem;
  color: #cbd5e1;
  line-height: 1.4;
  margin-bottom: 6px;
}

.card-assignee {
  font-size: 0.75rem;
  color: #64748b;
}

.assignee-icon {
  font-size: 0.7rem;
}

.empty-col {
  color: #334155;
  font-size: 0.8rem;
  text-align: center;
  padding: 20px 0;
}

/* ── Priority badges ── */
.priority-badge {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.priority-badge.lg {
  font-size: 0.75rem;
  padding: 3px 8px;
}

.priority-critical { background: #7f1d1d; color: #fca5a5; }
.priority-high     { background: #7c2d12; color: #fdba74; }
.priority-med      { background: #1e3a5f; color: #93c5fd; }
.priority-low      { background: #1e293b; color: #64748b; }

/* ── Rejected section ── */
.rejected-section {
  flex-shrink: 0;
  border-top: 1px solid #1e2235;
  background: #0d0f18;
  padding: 0 0 8px;
}

.rejected-toggle {
  width: 100%;
  background: none;
  border: none;
  color: #ef4444;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 10px 16px;
  display: flex;
  justify-content: space-between;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.rejected-toggle:hover { color: #fca5a5; }

.rejected-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 16px;
}

.rejected-cards .ticket-card {
  width: 200px;
  flex-shrink: 0;
}

/* ── Detail panel ── */
.detail-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  z-index: 100;
}

.detail-panel {
  width: 420px;
  max-width: 100vw;
  background: #12151f;
  border-left: 1px solid #2d3148;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 24px;
  gap: 20px;
}

.panel-close {
  align-self: flex-end;
  background: none;
  border: none;
  color: #64748b;
  font-size: 1.1rem;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  margin-bottom: -8px;
}
.panel-close:hover { color: #e2e8f0; background: #1e2235; }

.panel-header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.panel-title {
  margin: 0;
  font-size: 1.1rem;
  color: #f1f5f9;
  line-height: 1.4;
}

.panel-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #1a1d2e;
  border-radius: 8px;
  padding: 14px;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.meta-label {
  width: 72px;
  font-size: 0.75rem;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  flex-shrink: 0;
}

.meta-value {
  font-size: 0.875rem;
  color: #cbd5e1;
}

/* ── Status chip ── */
.status-chip {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 12px;
}

.status-new         { background: #1e293b; color: #94a3b8; }
.status-approved    { background: #1e3a5f; color: #93c5fd; }
.status-in_progress { background: #3d2b00; color: #fbbf24; }
.status-review      { background: #2d1b69; color: #c4b5fd; }
.status-done        { background: #022c22; color: #34d399; }
.status-rejected    { background: #450a0a; color: #fca5a5; }

/* ── Transitions ── */
.panel-transitions, .panel-comment {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.transitions-label {
  font-size: 0.75rem;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
}

.transition-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.btn-action {
  padding: 6px 14px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
  transition: opacity 0.15s;
}
.btn-action:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-action.approve  { background: #1d4ed8; color: #fff; }
.btn-action.approve:hover:not(:disabled) { background: #2563eb; }

.btn-action.start    { background: #d97706; color: #fff; }
.btn-action.start:hover:not(:disabled) { background: #f59e0b; }

.btn-action.review   { background: #7c3aed; color: #fff; }
.btn-action.review:hover:not(:disabled) { background: #8b5cf6; }

.btn-action.done     { background: #059669; color: #fff; }
.btn-action.done:hover:not(:disabled) { background: #10b981; }

.btn-action.reject   { background: #991b1b; color: #fff; }
.btn-action.reject:hover:not(:disabled) { background: #dc2626; }

.btn-action.back     { background: #1e2235; color: #94a3b8; border: 1px solid #2d3148; }
.btn-action.back:hover:not(:disabled) { background: #2d3148; }

.btn-action.reopen   { background: #1e2235; color: #93c5fd; border: 1px solid #3b82f6; }
.btn-action.reopen:hover:not(:disabled) { background: #1e3a5f; }

.completed-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #022c22;
  color: #34d399;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
}

.transition-error {
  color: #f87171;
  font-size: 0.8rem;
  padding: 4px 0;
}

/* ── Comment ── */
.comment-input {
  width: 100%;
  background: #1a1d2e;
  border: 1px solid #2d3148;
  border-radius: 6px;
  color: #e2e8f0;
  padding: 10px 12px;
  font-size: 0.875rem;
  resize: vertical;
  font-family: inherit;
  box-sizing: border-box;
}
.comment-input:focus {
  outline: none;
  border-color: #6366f1;
}

/* ── Buttons ── */
.btn-primary {
  background: #6366f1;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 18px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-primary:hover:not(:disabled) { background: #818cf8; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary.sm { padding: 6px 14px; font-size: 0.8rem; }

.btn-secondary {
  background: #1e2235;
  color: #94a3b8;
  border: 1px solid #2d3148;
  border-radius: 6px;
  padding: 8px 18px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-secondary:hover { background: #2d3148; color: #e2e8f0; }

/* ── New ticket modal ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: #12151f;
  border: 1px solid #2d3148;
  border-radius: 12px;
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 24px;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.modal-header h3 {
  margin: 0;
  font-size: 1.1rem;
  color: #f1f5f9;
}

.ticket-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-field label {
  font-size: 0.8rem;
  color: #94a3b8;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.required { color: #f87171; }

.form-input, .form-select {
  background: #1a1d2e;
  border: 1px solid #2d3148;
  border-radius: 6px;
  color: #e2e8f0;
  padding: 9px 12px;
  font-size: 0.9rem;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.form-input:focus, .form-select:focus {
  outline: none;
  border-color: #6366f1;
}
.form-select option { background: #1a1d2e; }

.form-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 4px;
}

/* ── Transitions (Vue) ── */
.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: transform 0.25s ease;
}
.panel-slide-enter-from .detail-panel,
.panel-slide-leave-to .detail-panel {
  transform: translateX(100%);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ── Scrollbars ── */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #2d3148; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #4a5568; }
</style>
