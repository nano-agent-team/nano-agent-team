<template>
  <div class="setup-wizard">
    <div class="wizard-header">
      <span class="wizard-logo">🤖</span>
      <h1>Vítej v nano-agent-team</h1>
      <p class="wizard-subtitle">Nastavení zabere asi 2 minuty.</p>
    </div>

    <!-- Step 1: Provider -->
    <div v-if="step === 1" class="wizard-step">
      <h2>Připoj Claude</h2>
      <p class="step-desc">
        nano-agent-team používá Claude jako AI backend.
        Zadej svůj Anthropic API klíč nebo Claude Code OAuth token.
      </p>
      <div class="form-group">
        <label>API klíč</label>
        <input
          v-model="apiKey"
          type="password"
          placeholder="sk-ant-api03-..."
          class="form-input"
          :class="{ error: apiKeyError }"
          @keyup.enter="connectProvider"
        />
        <span v-if="apiKeyError" class="form-error">{{ apiKeyError }}</span>
      </div>
      <button class="btn-primary" :disabled="connecting" @click="connectProvider">
        <span v-if="connecting">Připojuji...</span>
        <span v-else>Připojit Claude →</span>
      </button>
    </div>

    <!-- Step 2: Choose what to install -->
    <div v-if="step === 2" class="wizard-step">
      <h2>Co chceš nainstalovat?</h2>
      <p class="step-desc">
        Vyber týmy a featury. Vše lze přidat nebo odebrat i později v Settings.
      </p>

      <div v-if="available.teams.length > 0" class="install-section">
        <h3>Týmy</h3>
        <label
          v-for="team in available.teams"
          :key="team.id"
          class="install-item"
        >
          <input type="checkbox" :value="team.id" v-model="selectedInstall" />
          <span class="install-name">{{ team.name }}</span>
          <span class="install-id">{{ team.id }}</span>
        </label>
      </div>

      <div v-if="available.features.length > 0" class="install-section">
        <h3>Featury</h3>
        <label
          v-for="feature in available.features"
          :key="feature.id"
          class="install-item"
        >
          <input type="checkbox" :value="feature.id" v-model="selectedInstall" />
          <span class="install-name">{{ feature.name }}</span>
          <span class="install-id">{{ feature.id }}</span>
        </label>
      </div>

      <div v-if="available.teams.length === 0 && available.features.length === 0" class="empty-available">
        Zatím žádné týmy ani featury — přidáš je později přes Settings.
      </div>

      <div class="step-actions">
        <button class="btn-secondary" @click="step = 1">← Zpět</button>
        <button class="btn-primary" :disabled="completing" @click="complete">
          <span v-if="completing">Spouštím...</span>
          <span v-else">Spustit systém →</span>
        </button>
      </div>
    </div>

    <!-- Step 3: Done -->
    <div v-if="step === 3" class="wizard-step wizard-done">
      <div class="done-icon">✅</div>
      <h2>Systém je připraven!</h2>
      <p>Přesměrovávám na dashboard...</p>
    </div>

    <div v-if="globalError" class="global-error">{{ globalError }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const step = ref(1)
const apiKey = ref('')
const apiKeyError = ref('')
const connecting = ref(false)
const completing = ref(false)
const globalError = ref('')

const available = ref<{ teams: {id:string;name:string}[]; features: {id:string;name:string}[] }>({
  teams: [],
  features: [],
})
const selectedInstall = ref<string[]>([])

onMounted(async () => {
  // If already configured, skip to step 2
  try {
    const res = await fetch('/api/config/status')
    const status = await res.json() as { complete: boolean; setupCompleted: boolean }
    if (status.complete) {
      window.location.href = '/'
      return
    }
    if (status.setupCompleted) {
      // Provider set but setup not marked complete (unlikely edge case)
    }
  } catch { /* ignore */ }
})

async function connectProvider() {
  apiKeyError.value = ''
  const key = apiKey.value.trim()
  if (!key) {
    apiKeyError.value = 'API klíč nesmí být prázdný'
    return
  }

  connecting.value = true
  try {
    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: { type: 'claude-code', apiKey: key } }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    // Load available items for step 2
    const avRes = await fetch('/api/available')
    if (avRes.ok) {
      available.value = await avRes.json() as typeof available.value
    }

    step.value = 2
  } catch (err) {
    apiKeyError.value = `Chyba při ukládání: ${String(err)}`
  } finally {
    connecting.value = false
  }
}

async function complete() {
  completing.value = true
  globalError.value = ''
  try {
    const res = await fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install: selectedInstall.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    step.value = 3
    setTimeout(() => { window.location.href = '/' }, 1500)
  } catch (err) {
    globalError.value = `Chyba při spuštění: ${String(err)}`
  } finally {
    completing.value = false
  }
}
</script>

<style scoped>
.setup-wizard {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: var(--bg, #0d1117);
  color: var(--text, #e6edf3);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.wizard-header {
  text-align: center;
  margin-bottom: 40px;
}

.wizard-logo { font-size: 48px; display: block; margin-bottom: 12px; }

.wizard-header h1 {
  font-size: 24px;
  font-weight: 700;
  color: var(--accent, #58a6ff);
  margin: 0 0 8px;
}

.wizard-subtitle {
  color: var(--text-muted, #8b949e);
  font-size: 14px;
  margin: 0;
}

.wizard-step {
  width: 100%;
  max-width: 480px;
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  padding: 32px;
}

.wizard-step h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 8px;
}

.step-desc {
  color: var(--text-muted, #8b949e);
  font-size: 13px;
  margin: 0 0 24px;
  line-height: 1.5;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-muted, #8b949e);
}

.form-input {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  color: var(--text, #e6edf3);
  font-size: 14px;
  font-family: 'SF Mono', Consolas, monospace;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.15s;
}

.form-input:focus { border-color: var(--accent, #58a6ff); }
.form-input.error { border-color: var(--danger, #f85149); }

.form-error {
  font-size: 12px;
  color: var(--danger, #f85149);
  margin-top: 4px;
  display: block;
}

.btn-primary {
  width: 100%;
  padding: 10px 16px;
  background: var(--accent, #58a6ff);
  color: #0d1117;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-primary:hover:not(:disabled) { opacity: 0.85; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary {
  padding: 10px 16px;
  background: transparent;
  color: var(--text-muted, #8b949e);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.btn-secondary:hover { border-color: var(--text-muted, #8b949e); }

.install-section { margin-bottom: 20px; }
.install-section h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted, #8b949e);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 8px;
}

.install-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: background 0.1s;
}

.install-item:hover { background: var(--surface2, #1c2128); }
.install-item input { margin: 0; }
.install-name { flex: 1; font-size: 14px; }
.install-id { font-size: 11px; color: var(--text-muted, #8b949e); font-family: monospace; }

.empty-available {
  text-align: center;
  color: var(--text-muted, #8b949e);
  font-size: 13px;
  padding: 20px;
}

.step-actions {
  display: flex;
  gap: 12px;
  margin-top: 24px;
}

.step-actions .btn-primary { flex: 1; }

.wizard-done {
  text-align: center;
}

.done-icon { font-size: 48px; margin-bottom: 12px; }
.wizard-done h2 { color: var(--accent2, #3fb950); }

.global-error {
  margin-top: 16px;
  padding: 12px;
  background: rgba(248, 81, 73, 0.1);
  border: 1px solid var(--danger, #f85149);
  border-radius: 6px;
  color: var(--danger, #f85149);
  font-size: 13px;
  max-width: 480px;
  width: 100%;
}
</style>
