<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="$emit('close')" @keydown.esc="$emit('close')">
      <div class="modal" role="dialog" aria-modal="true">
        <!-- Header -->
        <div class="modal-header">
          <div class="modal-title">
            <span class="modal-agent-name">{{ manifest?.name ?? agentId }}</span>
            <span class="modal-agent-id">{{ agentId }}</span>
          </div>
          <button class="close-btn" @click="$emit('close')" aria-label="Close">×</button>
        </div>

        <div v-if="loading" class="modal-body loading-state">Loading...</div>

        <div v-else class="modal-body">
          <!-- System behavior (read-only) -->
          <section class="modal-section">
            <div class="section-label">SYSTEM BEHAVIOR</div>
            <pre class="base-instructions-pre">{{ baseInstructions || '(no CLAUDE.md)' }}</pre>
          </section>

          <!-- Custom instructions -->
          <section class="modal-section">
            <div class="section-label">CUSTOM INSTRUCTIONS</div>
            <textarea
              v-model="customInstructions"
              class="custom-instructions-area"
              rows="8"
              placeholder="Enter custom instructions..."
            ></textarea>
            <div class="field-hint">Appended on next restart</div>
          </section>

          <!-- Settings -->
          <section class="modal-section">
            <div class="section-label">SETTINGS</div>
            <div class="field-row">
              <label class="field-label">Model override</label>
              <input
                v-model="modelOverride"
                class="field-input"
                type="text"
                :placeholder="manifest?.model ?? 'default'"
              />
            </div>
          </section>
        </div>

        <!-- Footer -->
        <div class="modal-footer">
          <div class="footer-left">
            <button class="btn btn-primary" :disabled="saveStatus === 'saving'" @click="save">
              {{ saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : saveStatus === 'error' ? 'Error' : 'Save' }}
            </button>
          </div>
          <div class="footer-right">
            <button class="btn btn-secondary" :disabled="restartStatus === 'restarting'" @click="restart">
              {{ restartStatus === 'restarting' ? 'Restarting...' : restartStatus === 'done' ? 'Done!' : restartStatus === 'error' ? 'Error' : 'Restart agent' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface AgentManifest {
  id: string
  name?: string
  model?: string
  [key: string]: unknown
}

const props = defineProps<{ agentId: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const loading = ref(true)
const manifest = ref<AgentManifest | null>(null)
const baseInstructions = ref('')
const customInstructions = ref('')
const modelOverride = ref('')

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
type RestartStatus = 'idle' | 'restarting' | 'done' | 'error'

const saveStatus = ref<SaveStatus>('idle')
const restartStatus = ref<RestartStatus>('idle')

async function loadConfig() {
  try {
    const res = await fetch(`/api/agents/${props.agentId}/config`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as {
      manifest: AgentManifest
      baseInstructions: string
      customInstructions: string | null
      customConfig: { model?: string }
    }
    manifest.value = data.manifest
    baseInstructions.value = data.baseInstructions
    customInstructions.value = data.customInstructions ?? ''
    modelOverride.value = data.customConfig.model ?? ''
  } catch (e) {
    console.error('Failed to load agent config', e)
  } finally {
    loading.value = false
  }
}

async function save() {
  saveStatus.value = 'saving'
  try {
    const body = {
      customInstructions: customInstructions.value,
      customConfig: { ...(modelOverride.value ? { model: modelOverride.value } : {}) },
    }
    const res = await fetch(`/api/agents/${props.agentId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    saveStatus.value = 'saved'
    setTimeout(() => { saveStatus.value = 'idle' }, 2000)
  } catch (e) {
    console.error('Save failed', e)
    saveStatus.value = 'error'
    setTimeout(() => { saveStatus.value = 'idle' }, 3000)
  }
}

async function restart() {
  restartStatus.value = 'restarting'
  try {
    const res = await fetch(`/api/agents/${props.agentId}/restart`, { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    restartStatus.value = 'done'
    setTimeout(() => { restartStatus.value = 'idle' }, 2000)
  } catch (e) {
    console.error('Restart failed', e)
    restartStatus.value = 'error'
    setTimeout(() => { restartStatus.value = 'idle' }, 3000)
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  loadConfig()
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 10px;
  width: 640px;
  max-width: 95vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  font-family: monospace;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, #30363d);
  flex-shrink: 0;
}

.modal-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.modal-agent-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--text, #e6edf3);
}

.modal-agent-id {
  font-size: 12px;
  color: var(--text-muted, #8b949e);
}

.close-btn {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  line-height: 1;
  padding: 0 4px;
}

.close-btn:hover {
  color: var(--text, #e6edf3);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.loading-state {
  padding: 40px;
  text-align: center;
  color: var(--text-muted, #8b949e);
}

.modal-section {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, #30363d);
}

.modal-section:last-child {
  border-bottom: none;
}

.section-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: var(--text-muted, #8b949e);
  text-transform: uppercase;
  margin-bottom: 10px;
}

.base-instructions-pre {
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 11px;
  color: var(--text, #e6edf3);
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  font-family: monospace;
}

.custom-instructions-area {
  width: 100%;
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text, #e6edf3);
  font-family: monospace;
  resize: vertical;
  box-sizing: border-box;
}

.custom-instructions-area:focus {
  outline: none;
  border-color: var(--accent, #58a6ff);
}

.field-hint {
  font-size: 11px;
  color: var(--text-muted, #8b949e);
  margin-top: 6px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.field-label {
  font-size: 12px;
  color: var(--text-muted, #8b949e);
  white-space: nowrap;
  min-width: 110px;
}

.field-input {
  flex: 1;
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text, #e6edf3);
  font-family: monospace;
}

.field-input:focus {
  outline: none;
  border-color: var(--accent, #58a6ff);
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-top: 1px solid var(--border, #30363d);
  flex-shrink: 0;
}

.footer-left,
.footer-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn {
  padding: 7px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  font-family: monospace;
  transition: opacity 0.15s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent, #58a6ff);
  color: #000;
  border-color: var(--accent, #58a6ff);
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.85;
}

.btn-secondary {
  background: transparent;
  color: var(--text, #e6edf3);
  border-color: var(--border, #30363d);
}

.btn-secondary:hover:not(:disabled) {
  border-color: var(--accent, #58a6ff);
  color: var(--accent, #58a6ff);
}
</style>
