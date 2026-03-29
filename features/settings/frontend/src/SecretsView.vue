<template>
  <div class="secrets-view">
    <div class="secrets-header">
      <h1>Secrets</h1>
    </div>

    <div class="secrets-body">
      <!-- Warning banner -->
      <div class="warning-banner">
        LLM agents never receive secret values. Secrets are injected as environment variables into agent containers at startup.
      </div>

      <!-- Add Secret -->
      <div class="secrets-section">
        <div class="section-title-row">
          <h2>Stored Secrets</h2>
          <button class="btn-primary" @click="openAddForm">+ Add Secret</button>
        </div>

        <!-- Add / Edit form -->
        <div v-if="showForm" class="secret-form">
          <div class="field-row">
            <label class="field-label">Key</label>
            <input
              v-model="formKey"
              type="text"
              placeholder="e.g. GH_TOKEN, SLACK_WEBHOOK_URL"
              class="field-input"
              :disabled="formMode === 'edit'"
            />
          </div>
          <div class="field-row">
            <label class="field-label">Value</label>
            <input
              v-model="formValue"
              type="password"
              placeholder="Secret value..."
              class="field-input"
            />
          </div>
          <div class="form-actions">
            <button
              class="btn-primary"
              :disabled="!formKey.trim() || !formValue.trim() || formSaving"
              @click="saveSecret"
            >{{ formSaving ? 'Saving...' : formMode === 'edit' ? 'Update Secret' : 'Save Secret' }}</button>
            <button class="btn-secondary" @click="closeForm">Cancel</button>
          </div>
          <div v-if="formError" class="error-msg">{{ formError }}</div>
        </div>

        <!-- Secrets table -->
        <div v-if="loading" class="loading">Loading secrets...</div>
        <div v-else-if="loadError" class="error-msg">{{ loadError }}</div>
        <div v-else-if="secrets.length === 0 && !showForm" class="empty-state">
          No secrets stored yet. Click "Add Secret" to create one.
        </div>
        <table v-else-if="secrets.length > 0" class="secrets-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="secret in secrets" :key="secret.key">
              <td class="key-cell"><code>{{ secret.key }}</code></td>
              <td>
                <span v-if="secret.set" class="status-set">Set</span>
                <span v-else class="status-missing">Missing</span>
              </td>
              <td class="actions-cell">
                <button class="btn-action" @click="editSecret(secret.key)">Edit</button>
                <button class="btn-action btn-danger" @click="confirmDelete(secret.key)">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Required by agents -->
      <div v-if="Object.keys(required).length > 0" class="secrets-section">
        <h2>Required by Agents</h2>
        <div v-for="(keys, agentId) in required" :key="agentId" class="agent-req">
          <div class="agent-name">{{ agentId }}</div>
          <div class="agent-keys">
            <span
              v-for="k in keys"
              :key="k"
              :class="['req-key', isSecretSet(k) ? 'req-set' : 'req-missing']"
            >
              {{ k }}
              <span v-if="isSecretSet(k)" class="req-icon">&#x2705;</span>
              <span v-else class="req-icon">&#x274C;</span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Delete confirmation modal -->
    <div v-if="deleteKey" class="modal-overlay" @click.self="deleteKey = null">
      <div class="modal-box">
        <h3>Delete Secret</h3>
        <p>Are you sure you want to delete <code>{{ deleteKey }}</code>? This action cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn-secondary" @click="deleteKey = null">Cancel</button>
          <button class="btn-primary btn-delete" :disabled="deleting" @click="doDelete">
            {{ deleting ? 'Deleting...' : 'Delete' }}
          </button>
        </div>
        <div v-if="deleteError" class="error-msg">{{ deleteError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface SecretEntry { key: string; set: boolean }

const secrets = ref<SecretEntry[]>([])
const required = ref<Record<string, string[]>>({})
const loading = ref(true)
const loadError = ref('')

// Form state
const showForm = ref(false)
const formMode = ref<'add' | 'edit'>('add')
const formKey = ref('')
const formValue = ref('')
const formSaving = ref(false)
const formError = ref('')

// Delete state
const deleteKey = ref<string | null>(null)
const deleting = ref(false)
const deleteError = ref('')

function isSecretSet(key: string): boolean {
  return secrets.value.some(s => s.key === key && s.set)
}

async function loadSecrets() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetch('/api/secrets')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { secrets: SecretEntry[]; required: Record<string, string[]> }
    secrets.value = data.secrets ?? []
    required.value = data.required ?? {}
  } catch (e: unknown) {
    loadError.value = `Failed to load secrets: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    loading.value = false
  }
}

function openAddForm() {
  formMode.value = 'add'
  formKey.value = ''
  formValue.value = ''
  formError.value = ''
  showForm.value = true
}

function editSecret(key: string) {
  formMode.value = 'edit'
  formKey.value = key
  formValue.value = ''
  formError.value = ''
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  formKey.value = ''
  formValue.value = ''
  formError.value = ''
}

async function saveSecret() {
  formSaving.value = true
  formError.value = ''
  try {
    const res = await fetch('/api/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: formKey.value.trim(), value: formValue.value }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(body || `HTTP ${res.status}`)
    }
    closeForm()
    await loadSecrets()
  } catch (e: unknown) {
    formError.value = `Failed to save: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    formSaving.value = false
  }
}

function confirmDelete(key: string) {
  deleteKey.value = key
  deleteError.value = ''
}

async function doDelete() {
  if (!deleteKey.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    const res = await fetch(`/api/secrets/${encodeURIComponent(deleteKey.value)}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(body || `HTTP ${res.status}`)
    }
    deleteKey.value = null
    await loadSecrets()
  } catch (e: unknown) {
    deleteError.value = `Failed to delete: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    deleting.value = false
  }
}

onMounted(loadSecrets)
</script>

<style scoped>
.secrets-view {
  padding: 24px;
  max-width: 720px;
  margin: 0 auto;
  color: var(--text, #e6edf3);
}

.secrets-header h1 {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 12px;
}

.secrets-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.warning-banner {
  background: rgba(210, 153, 34, 0.08);
  border: 1px solid rgba(210, 153, 34, 0.3);
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 13px;
  color: #d29922;
}

.secrets-section {
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  padding: 20px;
}

.secrets-section h2 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-muted, #8b949e);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 16px;
}

.section-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.section-title-row h2 {
  margin: 0;
}

.loading { font-size: 13px; color: var(--text-muted, #8b949e); }
.error-msg { color: var(--danger, #f85149); font-size: 13px; margin: 8px 0; }

.empty-state {
  font-size: 13px;
  color: var(--text-muted, #8b949e);
  padding: 16px 0;
}

/* Form */
.secret-form {
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: 12px;
  color: var(--text-muted, #8b949e);
  font-weight: 600;
}

.field-input {
  padding: 8px 12px;
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  color: var(--text, #e6edf3);
  font-size: 13px;
  outline: none;
}
.field-input:focus { border-color: var(--accent, #58a6ff); }
.field-input:disabled { opacity: 0.5; }

.form-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* Table */
.secrets-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.secrets-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #8b949e);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #30363d);
}

.secrets-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border, #30363d);
}

.secrets-table tbody tr:last-child td {
  border-bottom: none;
}

.secrets-table tbody tr:hover {
  background: var(--surface2, #1c2128);
}

.key-cell code {
  font-size: 13px;
  background: var(--surface2, #1c2128);
  padding: 2px 6px;
  border-radius: 4px;
}

.status-set {
  font-size: 12px;
  background: rgba(63, 185, 80, 0.1);
  color: var(--accent2, #3fb950);
  padding: 2px 8px;
  border-radius: 4px;
}

.status-missing {
  font-size: 12px;
  background: rgba(248, 81, 73, 0.1);
  color: var(--danger, #f85149);
  padding: 2px 8px;
  border-radius: 4px;
}

.actions-cell {
  display: flex;
  gap: 6px;
}

.btn-action {
  padding: 4px 10px;
  background: none;
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  color: var(--text, #e6edf3);
  cursor: pointer;
  font-size: 12px;
}
.btn-action:hover { background: var(--surface2, #1c2128); }

.btn-danger {
  border-color: rgba(248, 81, 73, 0.4);
  color: var(--danger, #f85149);
}
.btn-danger:hover { background: rgba(248, 81, 73, 0.1); }

.btn-primary {
  padding: 8px 20px;
  background: var(--accent, #58a6ff);
  color: #0d1117;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary {
  padding: 6px 14px;
  background: var(--surface2, #1c2128);
  color: var(--text, #e6edf3);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}
.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-delete {
  background: var(--danger, #f85149);
  color: #fff;
}
.btn-delete:hover { background: #da3633; }

/* Required by agents */
.agent-req {
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 8px;
}
.agent-req:last-child { margin-bottom: 0; }

.agent-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}

.agent-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.req-key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 4px;
  font-family: monospace;
}

.req-set {
  background: rgba(63, 185, 80, 0.1);
  color: var(--accent2, #3fb950);
}

.req-missing {
  background: rgba(248, 81, 73, 0.1);
  color: var(--danger, #f85149);
}

.req-icon {
  font-size: 11px;
}

/* Delete modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-box {
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  padding: 24px;
  max-width: 420px;
  width: 90%;
}

.modal-box h3 {
  margin: 0 0 12px;
  font-size: 16px;
}

.modal-box p {
  font-size: 13px;
  color: var(--text-muted, #8b949e);
  margin: 0 0 16px;
}

.modal-box code {
  background: var(--surface2, #1c2128);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
  color: var(--text, #e6edf3);
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
