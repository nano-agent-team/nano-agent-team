<template>
  <div class="setup-wizard">
    <div class="wizard-header">
      <span class="wizard-logo">🤖</span>
      <h1>Vítej v nano-agent-team</h1>
      <p class="wizard-subtitle">Nastavení zabere asi 2 minuty.</p>
    </div>

    <!-- Step 0: Choose primary LLM provider -->
    <div v-if="step === 0" class="wizard-step">
      <h2>Vyber LLM poskytovatele</h2>
      <p class="step-desc">
        Kterého poskytovatele chceš použít jako primárního?
      </p>

      <div class="provider-cards">
        <div
          class="provider-card"
          :class="{ selected: selectedProvider === 'claude' }"
          @click="selectProvider('claude')"
        >
          <div class="provider-icon">🧠</div>
          <div class="provider-name">Claude</div>
          <div class="provider-desc">Anthropic — nejlepší reasoning</div>
        </div>

        <div
          class="provider-card"
          :class="{ selected: selectedProvider === 'codex' }"
          @click="selectProvider('codex')"
        >
          <div class="provider-icon">⚡</div>
          <div class="provider-name">Codex</div>
          <div class="provider-desc">OpenAI — rychlý, levný</div>
        </div>

        <div class="provider-card provider-card--disabled">
          <div class="provider-icon">✨</div>
          <div class="provider-name">Gemini <span class="provider-badge">brzy</span></div>
          <div class="provider-desc">Google — zatím nedostupné</div>
        </div>
      </div>

      <button class="btn-primary" @click="step = 1">
        Pokračovat s {{ selectedProvider }} →
      </button>
    </div>

    <!-- Step 1: Configure selected provider -->
    <div v-if="step === 1" class="wizard-step">
      <h2>Nakonfiguruj {{ selectedProvider }}</h2>
      <p class="step-desc">
        Vyber způsob přihlášení pro {{ selectedProvider }}.
      </p>

      <!-- Provider type toggle - CLAUDE -->
      <div v-if="selectedProvider === 'claude'" class="provider-toggle">
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

      <!-- Provider type toggle - CODEX -->
      <div v-if="selectedProvider === 'codex'" class="provider-toggle">
        <button
          class="toggle-btn"
          :class="{ active: providerType === 'api-key' }"
          @click="providerType = 'api-key'"
        >
          🔑 API klíč
        </button>
        <button
          class="toggle-btn"
          :class="{ active: providerType === 'subscription' }"
          @click="providerType = 'subscription'"
        >
          🔐 ChatGPT subscription
        </button>
      </div>

      <!-- Provider type toggle - GEMINI -->
      <div v-if="selectedProvider === 'gemini'" class="provider-toggle">
        <button
          class="toggle-btn"
          :class="{ active: providerType === 'api-key' }"
          @click="providerType = 'api-key'"
        >
          🔑 API klíč
        </button>
      </div>

      <!-- API key mode - CLAUDE -->
      <div v-if="selectedProvider === 'claude' && providerType === 'api-key'" class="form-group">
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

      <!-- API key mode - CODEX -->
      <div v-if="selectedProvider === 'codex' && providerType === 'api-key'" class="form-group">
        <label>OpenAI API klíč</label>
        <input
          v-model="codexApiKey"
          type="password"
          placeholder="sk-proj-..."
          class="form-input"
          :class="{ error: apiKeyError }"
          @keyup.enter="connectProvider"
        />
        <span v-if="apiKeyError" class="form-error">{{ apiKeyError }}</span>
      </div>

      <!-- API key mode - GEMINI -->
      <div v-if="selectedProvider === 'gemini' && providerType === 'api-key'" class="form-group">
        <label>Google Gemini API klíč</label>
        <input
          v-model="geminiApiKey"
          type="password"
          placeholder="AIza..."
          class="form-input"
          :class="{ error: apiKeyError }"
          @keyup.enter="connectProvider"
        />
        <span v-if="apiKeyError" class="form-error">{{ apiKeyError }}</span>
      </div>

      <!-- Codex subscription mode -->
      <div v-if="selectedProvider === 'codex' && providerType === 'subscription'" class="codex-subscription-info">

        <!-- idle -->
        <div v-if="codexOauthState === 'idle'" class="info-box">
          <p>
            Přihlásí se přes tvůj OpenAI / ChatGPT účet (s aktivní Codex subscription).
            Credentials se uloží do <code>~/.codex/auth.json</code>.
          </p>
          <p class="info-note">
            Po kliknutí "Připojit codex →" se vygeneruje přihlašovací odkaz.
          </p>
        </div>

        <!-- loading -->
        <div v-if="codexOauthState === 'loading'" class="info-box info-box--loading">
          <span class="spinner">⏳</span> Generuji přihlašovací odkaz...
        </div>

        <!-- URL ready -->
        <div v-if="codexOauthState === 'waiting'" class="info-box info-box--url">
          <p class="url-label">Otevři odkaz a přihlas se svým OpenAI účtem:</p>
          <a :href="codexOauthUrl" target="_blank" class="oauth-link">
            🔗 Přihlásit se u OpenAI →
          </a>
          <p class="info-note" style="margin-top:12px">
            Po přihlášení se credentials automaticky uloží a setup pokračuje...
          </p>
        </div>

        <!-- done -->
        <div v-if="codexOauthState === 'done'" class="info-box info-box--success">
          ✅ Codex přihlášen — credentials uloženy.
        </div>

        <span v-if="apiKeyError" class="form-error">{{ apiKeyError }}</span>
      </div>

      <!-- Claude Code subscription mode -->
      <div v-if="selectedProvider === 'claude' && providerType === 'claude-code'" class="claude-code-info">

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
        v-if="(providerType === 'api-key') || (selectedProvider === 'claude' && oauthState === 'idle') || (selectedProvider === 'codex' && providerType === 'subscription' && codexOauthState === 'idle')"
        class="btn-primary"
        :disabled="connecting"
        @click="connectProvider"
      >
        <span v-if="connecting">Připojuji...</span>
        <span v-else>Připojit {{ selectedProvider }} →</span>
      </button>
    </div>

    <!-- Step 2: Done -->
    <div v-if="step === 2" class="wizard-step wizard-done">
      <div class="done-icon">✅</div>
      <h2>Systém je připraven!</h2>
      <p>Přesměrovávám na dashboard...</p>
    </div>

    <div v-if="globalError" class="global-error">{{ globalError }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'

const step = ref(0)
const selectedProvider = ref<'claude' | 'codex' | 'gemini'>('claude')
const providerType = ref<'api-key' | 'claude-code' | 'subscription' | 'codex-api'>('api-key')
const apiKey = ref('')
const codexApiKey = ref('')
const geminiApiKey = ref('')
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
const codexLoginLoading = ref(false)
const codexLoginStatus = ref('')
const codexOauthState = ref<'idle' | 'loading' | 'waiting' | 'done'>('idle')
const codexOauthUrl = ref('')

// Reset oauth state when switching provider type
watch(providerType, () => {
  oauthState.value = 'idle'
  oauthUrl.value = ''
  oauthClicked.value = false
  apiKeyError.value = ''
})

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
  eventSource.addEventListener('auth-completed', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { type?: string }
      if (data.type === 'codex-oauth') {
        codexOauthState.value = 'done'
        void proceedAfterCodexLogin()
      } else {
        oauthState.value = 'done'
        void proceedAfterOauth()
      }
    } catch {
      oauthState.value = 'done'
      void proceedAfterOauth()
    }
  })
})

// Codex SSE auth je obsluhován globálním eventSource listenerem výše
function listenForCodexAuth() { /* SSE listener in onMounted handles auth-completed */ }

function selectProvider(provider: 'claude' | 'codex' | 'gemini') {
  selectedProvider.value = provider
  providerType.value = 'api-key'
  apiKey.value = ''
  codexApiKey.value = ''
  geminiApiKey.value = ''
  apiKeyError.value = ''
  oauthState.value = 'idle'
}

async function connectProvider() {
  apiKeyError.value = ''

  // Handle Codex subscription
  if (selectedProvider.value === 'codex' && providerType.value === 'subscription') {
    codexOauthState.value = 'loading'
    apiKeyError.value = ''
    try {
      const res = await fetch('/api/auth/codex-login', { method: 'POST' })
      const data = await res.json() as { url?: string; alreadyLoggedIn?: boolean; error?: string }

      if (!res.ok || data.error) {
        apiKeyError.value = data.error ?? `HTTP ${res.status}`
        codexOauthState.value = 'idle'
        return
      }

      if (data.alreadyLoggedIn) {
        codexOauthState.value = 'done'
        await new Promise(r => setTimeout(r, 1000))
        await proceedAfterCodexLogin()
        return
      }

      if (data.url) {
        codexOauthUrl.value = data.url
        codexOauthState.value = 'waiting'
        // Čekej na SSE event auth-completed
        listenForCodexAuth()
      }
    } catch (err) {
      apiKeyError.value = `Chyba: ${String(err)}`
      codexOauthState.value = 'idle'
    }
    return
  }

  // Handle Claude
  if (selectedProvider.value === 'claude' && providerType.value === 'claude-code') {
    // Spustí claude auth login na backendu a čeká na URL
    oauthState.value = 'loading'
    try {
      const res = await fetch('/api/auth/claude-login', { method: 'POST' })
      const data = await res.json() as { url?: string; port?: number; alreadyLoggedIn?: boolean; error?: string }

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
    let configPayload: any = {
      primaryProvider: selectedProvider.value,
      providers: {}
    }

    // Determine which key to use based on selected provider
    let key: string | undefined
    if (selectedProvider.value === 'claude') {
      key = apiKey.value.trim()
      if (key) {
        configPayload.providers.claude = { apiKey: key }
      }
    } else if (selectedProvider.value === 'codex') {
      key = codexApiKey.value.trim()
      if (key) {
        configPayload.providers.codex = { apiKey: key }
      }
    } else if (selectedProvider.value === 'gemini') {
      key = geminiApiKey.value.trim()
      if (key) {
        configPayload.providers.gemini = { apiKey: key }
      }
    }

    if (!key) {
      apiKeyError.value = `API klíč pro ${selectedProvider.value} nesmí být prázdný`
      return
    }

    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configPayload),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

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
  // Uloží primaryProvider + provider type (bez apiKey — klíč se čte z credentials.json)
  try {
    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primaryProvider: 'claude',
        provider: { type: 'claude-code-oauth' }
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    step.value = 2
  } catch (err) {
    apiKeyError.value = `Chyba při ukládání: ${String(err)}`
  }
}

async function proceedAfterCodexLogin() {
  // Uloží primaryProvider: codex (bez apiKey — klíč se čte z ~/.codex/auth.json)
  try {
    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primaryProvider: 'codex',
        providers: {
          codex: { /* auth managed by ~/.codex/auth.json */ }
        }
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    step.value = 2
  } catch (err) {
    apiKeyError.value = `Chyba při ukládání: ${String(err)}`
  }
}

async function complete() {
  completing.value = true
  globalError.value = ''
  try {
    const res = await fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install: [] }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    step.value = 2
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
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 32px 16px;
  overflow-y: auto;
  background: var(--bg, #0d1117);
  color: var(--text, #e6edf3);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.wizard-header {
  text-align: center;
  margin-top: auto;
  margin-bottom: 40px;
}

.wizard-step:last-of-type {
  margin-bottom: auto;
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
.provider-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin: 20px 0;
}

.provider-card {
  border: 2px solid #ddd;
  border-radius: 8px;
  padding: 16px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
}

.provider-card:hover {
  border-color: #007bff;
  background: #f8f9ff;
}

.provider-card.selected {
  border-color: #007bff;
  background: #e7f0ff;
  font-weight: bold;
}

.provider-card--disabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}

.provider-badge {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 500;
  background: #e5e7eb;
  color: #6b7280;
  border-radius: 4px;
  padding: 1px 5px;
  margin-left: 4px;
  vertical-align: middle;
}

.provider-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.provider-name {
  font-weight: 600;
  margin-bottom: 4px;
}

.provider-desc {
  font-size: 12px;
  color: #666;
}
</style>
