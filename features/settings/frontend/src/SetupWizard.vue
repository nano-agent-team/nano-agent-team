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
        Vyber způsob přihlášení.
      </p>

      <!-- Provider type toggle -->
      <div class="provider-toggle">
        <button
          class="toggle-btn"
          :class="{ active: providerType === 'api-key' }"
          @click="providerType = 'api-key'"
        >
          🔑 API klíč
        </button>
        <button
          class="toggle-btn"
          :class="{ active: providerType === 'claude-code' }"
          @click="providerType = 'claude-code'"
        >
          ⚡ Claude Code subscription
        </button>
      </div>

      <!-- API key mode -->
      <div v-if="providerType === 'api-key'" class="form-group">
        <label>Anthropic API klíč</label>
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

      <!-- Claude Code subscription mode -->
      <div v-if="providerType === 'claude-code'" class="claude-code-info">

        <!-- Stav: idle -->
        <div v-if="oauthState === 'idle'" class="info-box">
          <p>
            Přihlásí se přes tvůj Anthropic účet (Claude Pro / Max subscription).
            Credentials se uloží do <code>~/.claude/.credentials.json</code>.
          </p>
          <p class="info-note">
            Po kliknutí "Připojit Claude →" se vygeneruje přihlašovací odkaz.
          </p>
        </div>

        <!-- Stav: loading URL -->
        <div v-if="oauthState === 'loading'" class="info-box info-box--loading">
          <span class="spinner">⏳</span> Generuji přihlašovací odkaz...
        </div>

        <!-- Stav: URL připravena — čekáme na kód -->
        <div v-if="oauthState === 'waiting'" class="info-box info-box--url">
          <p class="url-label">1. Otevři odkaz a přihlas se:</p>
          <a :href="oauthUrl" target="_blank" class="oauth-link" @click="oauthClicked = true">
            🔗 Přihlásit se u Anthropic →
          </a>
          <template v-if="oauthClicked">
            <p class="url-label" style="margin-top:16px">
              2. Na stránce Anthropic uvidíš kód — zkopíruj ho a vlož sem:
            </p>
            <div class="form-group" style="margin-bottom:10px">
              <input
                v-model="oauthCode"
                type="text"
                placeholder="Vlož kód ze stránky Anthropic..."
                class="form-input"
                :class="{ error: !!apiKeyError }"
                @keyup.enter="submitOauthCode"
              />
            </div>
            <button class="btn-done" :disabled="!oauthCode || submittingCode" @click="submitOauthCode">
              <span v-if="submittingCode">Ověřuji...</span>
              <span v-else>✅ Potvrdit kód →</span>
            </button>
          </template>
        </div>

        <!-- Stav: already logged in -->
        <div v-if="oauthState === 'done'" class="info-box info-box--success">
          ✅ Credentials nalezeny — Claude Code je připraven.
        </div>

        <span v-if="apiKeyError" class="form-error">{{ apiKeyError }}</span>
      </div>

      <button
        v-if="providerType === 'api-key' || oauthState === 'idle'"
        class="btn-primary"
        :disabled="connecting"
        @click="connectProvider"
      >
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
          <span v-else>Spustit systém →</span>
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
import { ref, onMounted, watch } from 'vue'

const step = ref(1)
const providerType = ref<'api-key' | 'claude-code'>('api-key')
const apiKey = ref('')
const apiKeyError = ref('')
const connecting = ref(false)
const completing = ref(false)
const globalError = ref('')

// OAuth state machine: idle → loading → waiting → done
const oauthState = ref<'idle' | 'loading' | 'waiting' | 'done'>('idle')
const oauthUrl = ref('')
const oauthClicked = ref(false)
const oauthCode = ref('')
const oauthPort = ref<number | null>(null)
const submittingCode = ref(false)

// Reset oauth state when switching provider type
watch(providerType, () => {
  oauthState.value = 'idle'
  oauthUrl.value = ''
  oauthClicked.value = false
  apiKeyError.value = ''
})

const available = ref<{ teams: {id:string;name:string}[]; features: {id:string;name:string}[] }>({
  teams: [],
  features: [],
})
const selectedInstall = ref<string[]>([])

// SSE — naslouchej na auth-completed event
let eventSource: EventSource | null = null
onMounted(async () => {
  try {
    const res = await fetch('/api/config/status')
    const status = await res.json() as { complete: boolean; setupCompleted: boolean }
    if (status.complete) {
      window.location.href = '/'
      return
    }
  } catch { /* ignore */ }

  // Listen for SSE auth-completed
  eventSource = new EventSource('/api/events')
  eventSource.addEventListener('auth-completed', () => {
    oauthState.value = 'done'
    void proceedAfterOauth()
  })
})

async function connectProvider() {
  apiKeyError.value = ''

  if (providerType.value === 'claude-code') {
    // Spustí claude auth login na backendu a čeká na URL
    oauthState.value = 'loading'
    try {
      const res = await fetch('/api/auth/claude-login', { method: 'POST' })
      const data = await res.json() as { url?: string; alreadyLoggedIn?: boolean; error?: string }

      if (!res.ok || data.error) {
        apiKeyError.value = data.error ?? `HTTP ${res.status}`
        oauthState.value = 'idle'
        return
      }

      if (data.alreadyLoggedIn) {
        oauthState.value = 'done'
        await proceedAfterOauth()
        return
      }

      oauthUrl.value = data.url ?? ''
      oauthPort.value = data.port ?? null
      oauthState.value = 'waiting'
    } catch (err) {
      apiKeyError.value = `Chyba: ${String(err)}`
      oauthState.value = 'idle'
    }
    return
  }

  // API key mode
  connecting.value = true
  try {
    const key = apiKey.value.trim()
    if (!key) {
      apiKeyError.value = 'API klíč nesmí být prázdný'
      return
    }

    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: { type: 'claude-code', apiKey: key } }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    await loadAvailable()
    step.value = 2
  } catch (err) {
    apiKeyError.value = `Chyba při ukládání: ${String(err)}`
  } finally {
    connecting.value = false
  }
}

async function submitOauthCode() {
  if (!oauthCode.value.trim()) return
  submittingCode.value = true
  apiKeyError.value = ''
  try {
    const res = await fetch('/api/auth/claude-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: oauthCode.value.trim() }),
    })
    const data = await res.json() as { ok?: boolean; error?: string }
    if (!res.ok || data.error) {
      apiKeyError.value = data.error ?? `HTTP ${res.status}`
      return
    }
    oauthState.value = 'done'
    await proceedAfterOauth()
  } catch (err) {
    apiKeyError.value = `Chyba: ${String(err)}`
  } finally {
    submittingCode.value = false
  }
}

async function proceedAfterOauth() {
  // Uloží provider type (bez apiKey — klíč se čte z credentials.json)
  try {
    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: { type: 'claude-code-oauth' } }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await loadAvailable()
    step.value = 2
  } catch (err) {
    apiKeyError.value = `Chyba při ukládání: ${String(err)}`
  }
}

async function loadAvailable() {
  const avRes = await fetch('/api/available')
  if (avRes.ok) {
    available.value = await avRes.json() as typeof available.value
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

/* OAuth flow */
.info-box--loading {
  color: var(--text-muted, #8b949e);
  text-align: center;
}

.spinner { font-size: 18px; }

.info-box--url { border-color: rgba(88, 166, 255, 0.4); background: rgba(88, 166, 255, 0.05); }
.info-box--success { border-color: rgba(63, 185, 80, 0.4); background: rgba(63, 185, 80, 0.05); color: var(--accent2, #3fb950); }

.url-label {
  font-size: 13px;
  color: var(--text-muted, #8b949e);
  margin-bottom: 10px;
}

.oauth-link {
  display: block;
  padding: 10px 14px;
  background: rgba(88, 166, 255, 0.1);
  border: 1px solid var(--accent, #58a6ff);
  border-radius: 6px;
  color: var(--accent, #58a6ff);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  text-align: center;
  transition: background 0.15s;
  word-break: break-all;
}

.oauth-link:hover { background: rgba(88, 166, 255, 0.2); }

.btn-done {
  width: 100%;
  margin-top: 12px;
  padding: 10px 16px;
  background: rgba(63, 185, 80, 0.15);
  border: 1px solid var(--accent2, #3fb950);
  border-radius: 6px;
  color: var(--accent2, #3fb950);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-done:hover { background: rgba(63, 185, 80, 0.25); }

/* Provider toggle */
.provider-toggle {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}

.toggle-btn {
  flex: 1;
  padding: 10px 12px;
  background: transparent;
  color: var(--text-muted, #8b949e);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}

.toggle-btn:hover { border-color: var(--accent, #58a6ff); color: var(--text, #e6edf3); }
.toggle-btn.active {
  background: rgba(88, 166, 255, 0.1);
  border-color: var(--accent, #58a6ff);
  color: var(--accent, #58a6ff);
}

/* Claude Code info box */
.claude-code-info { margin-bottom: 20px; }

.info-box {
  background: rgba(63, 185, 80, 0.05);
  border: 1px solid rgba(63, 185, 80, 0.3);
  border-radius: 6px;
  padding: 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text, #e6edf3);
}

.info-box p { margin: 0 0 10px; }
.info-box p:last-child { margin-bottom: 0; }

.info-steps { color: var(--text-muted, #8b949e); }

.info-note {
  color: var(--text-muted, #8b949e);
  font-size: 12px !important;
}

.code-block {
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  padding: 8px 12px;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 13px;
  color: var(--accent2, #3fb950);
  margin: 8px 0;
  overflow-x: auto;
}

code {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 12px;
  background: rgba(255,255,255,0.07);
  padding: 1px 5px;
  border-radius: 3px;
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
