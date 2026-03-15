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

        <div
          class="provider-card"
          :class="{ selected: selectedProvider === 'gemini' }"
          @click="selectProvider('gemini')"
        >
          <div class="provider-icon">✨</div>
          <div class="provider-name">Gemini</div>
          <div class="provider-desc">Google — multimodální</div>
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
        <div class="info-box">
          <p>
            Přihlásí se přes tvůj ChatGPT / OpenAI účet (s aktivní Codex subscription).
            Credentials se uloží do <code>~/.codex/auth.json</code>.
          </p>
          <p class="info-note">
            Po kliknutí "Připojit Codex →" se spustí Codex CLI autentizace.
          </p>
        </div>

        <div v-if="codexLoginLoading" class="info-box info-box--loading">
          <span class="spinner">⏳</span> Inicializuji Codex login...
        </div>

        <div v-if="codexLoginStatus" class="info-box info-box--success">
          ✅ {{ codexLoginStatus }}
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
        v-if="(providerType === 'api-key') || (selectedProvider === 'claude' && oauthState === 'idle') || (selectedProvider === 'codex' && providerType === 'subscription')"
        class="btn-primary"
        :disabled="connecting || codexLoginLoading"
        @click="connectProvider"
      >
        <span v-if="connecting || codexLoginLoading">Připojuji...</span>
        <span v-else>Připojit {{ selectedProvider }} →</span>
      </button>
    </div>

    <!-- Step 2: Choose what to install (hub catalog) -->
    <div v-if="step === 2" class="wizard-step wizard-step--wide">
      <h2>Co chceš nainstalovat?</h2>
      <p class="step-desc">
        Vyber týmy z katalogu. Kliknutím na kartu zobrazíš nastavení.
      </p>

      <div v-if="catalogLoading" class="catalog-loading">
        <span class="spinner">⏳</span> Načítám katalog...
      </div>

      <div v-if="!catalogLoading && catalog.teams.length === 0 && catalog.agents.length === 0" class="empty-available">
        Katalog je prázdný — přidáš týmy později přes Settings.
      </div>

      <!-- Teams -->
      <div v-if="!catalogLoading && catalog.teams.length > 0" class="install-section">
        <h3>Týmy</h3>
        <div
          v-for="item in catalog.teams"
          :key="item.id"
          class="catalog-card"
          :class="{ 'catalog-card--expanded': expandedItem === item.id }"
          @click="toggleItem(item.id)"
        >
          <div class="catalog-card-header">
            <div class="catalog-card-info">
              <span class="install-name">{{ item.name }}</span>
              <span class="install-id">{{ item.id }}</span>
              <span v-if="installedItems.includes(item.id)" class="badge-installed">✅ Nainstalováno</span>
            </div>
            <span class="catalog-card-chevron">{{ expandedItem === item.id ? '▲' : '▼' }}</span>
          </div>
          <p v-if="item.description" class="catalog-card-desc">{{ item.description }}</p>

          <!-- Inline requires form -->
          <div v-if="expandedItem === item.id && !installedItems.includes(item.id)" class="requires-form" @click.stop>
            <div v-if="item.requires && item.requires.length > 0">
              <div
                v-for="req in item.requires"
                :key="req.key"
                class="form-group"
              >
                <label>{{ req.label }}</label>
                <p v-if="req.help" class="field-help">{{ req.help }}</p>

                <!-- generate_ssh type -->
                <div v-if="req.type === 'generate_ssh'" class="ssh-field">
                  <button
                    class="btn-secondary btn-sm"
                    :disabled="sshGenerating[item.id]"
                    @click="generateSsh(item.id)"
                  >
                    <span v-if="sshGenerating[item.id]">Generuji...</span>
                    <span v-else>🔑 Vygenerovat klíč</span>
                  </button>
                  <div v-if="sshPublicKeys[item.id]" class="ssh-result">
                    <p class="field-help">Zkopíruj tento public key a přidej ho do GitHub (Settings → SSH Keys):</p>
                    <div class="code-block">{{ sshPublicKeys[item.id] }}</div>
                    <div class="ssh-actions">
                      <button class="btn-copy btn-sm" @click="copyToClipboard(sshPublicKeys[item.id])">
                        {{ copied ? '✅ Zkopírováno' : '📋 Kopírovat' }}
                      </button>
                      <a
                        v-if="deployKeyUrl(item.id)"
                        :href="deployKeyUrl(item.id)"
                        target="_blank"
                        class="btn-github btn-sm"
                      >
                        🔗 Přidat na GitHub →
                      </a>
                    </div>
                  </div>
                </div>

                <!-- boolean type -->
                <label v-else-if="req.type === 'boolean'" class="checkbox-label">
                  <input
                    type="checkbox"
                    :checked="!!itemConfigs[item.id]?.[req.key]"
                    @change="setItemConfig(item.id, req.key, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ req.label }}</span>
                </label>

                <!-- text / password / default -->
                <input
                  v-else
                  :type="req.type === 'password' ? 'password' : 'text'"
                  :placeholder="req.placeholder ?? ''"
                  :value="itemConfigs[item.id]?.[req.key] ?? ''"
                  class="form-input"
                  @input="setItemConfig(item.id, req.key, ($event.target as HTMLInputElement).value)"
                />
              </div>
            </div>

            <div v-if="installErrors[item.id]" class="form-error" style="margin-bottom:8px">{{ installErrors[item.id] }}</div>

            <button
              class="btn-primary btn-install"
              :disabled="installingItem === item.id"
              @click="installItem(item)"
            >
              <span v-if="installingItem === item.id">Instaluji...</span>
              <span v-else>Instalovat →</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Agents -->
      <div v-if="!catalogLoading && catalog.agents.length > 0" class="install-section">
        <h3>Agenti</h3>
        <div
          v-for="item in catalog.agents"
          :key="item.id"
          class="catalog-card"
          :class="{ 'catalog-card--expanded': expandedItem === item.id }"
          @click="toggleItem(item.id)"
        >
          <div class="catalog-card-header">
            <div class="catalog-card-info">
              <span class="install-name">{{ item.name }}</span>
              <span class="install-id">{{ item.id }}</span>
              <span v-if="installedItems.includes(item.id)" class="badge-installed">✅ Nainstalováno</span>
            </div>
            <span class="catalog-card-chevron">{{ expandedItem === item.id ? '▲' : '▼' }}</span>
          </div>
          <p v-if="item.description" class="catalog-card-desc">{{ item.description }}</p>

          <div v-if="expandedItem === item.id" class="requires-form" @click.stop>
            <div v-if="item.requires && item.requires.length > 0">
              <div v-for="req in item.requires" :key="req.key" class="form-group">
                <label>{{ req.label }}</label>
                <input
                  :type="req.type === 'password' ? 'password' : 'text'"
                  :placeholder="req.placeholder ?? ''"
                  :value="itemConfigs[item.id]?.[req.key] ?? ''"
                  class="form-input"
                  @input="setItemConfig(item.id, req.key, ($event.target as HTMLInputElement).value)"
                />
              </div>
            </div>
            <button
              class="btn-primary btn-install"
              :disabled="installingItem === item.id || installedItems.includes(item.id)"
              @click="installItem(item)"
            >
              <span v-if="installingItem === item.id">Instaluji...</span>
              <span v-else-if="installedItems.includes(item.id)">✅ Nainstalováno</span>
              <span v-else>Instalovat →</span>
            </button>
          </div>
        </div>
      </div>

      <div class="step-actions">
        <button class="btn-secondary" @click="step = 1">← Zpět</button>
        <button class="btn-primary" @click="step = 3">
          Další →
        </button>
      </div>
    </div>

    <!-- Step 3: Observability -->
    <div v-if="step === 3" class="wizard-step">
      <h2>Observability</h2>
      <p class="step-desc">
        Distributed tracing a centralizované logování. Volitelné — můžeš přeskočit.
      </p>

      <div class="obs-cards">
        <div
          v-for="opt in obsOptions"
          :key="opt.value"
          class="obs-card"
          :class="{ 'obs-card--active': obsLevel === opt.value }"
          @click="obsLevel = opt.value"
        >
          <div class="obs-card-header">
            <span class="obs-card-icon">{{ opt.icon }}</span>
            <span class="obs-card-title">{{ opt.label }}</span>
            <span v-if="opt.value === 'full'" class="obs-card-badge">doporučeno</span>
          </div>
          <p class="obs-card-desc">{{ opt.desc }}</p>
        </div>
      </div>

      <!-- Provider toggle for non-none -->
      <div v-if="obsLevel !== 'none'" class="obs-provider-section">
        <div class="provider-toggle" style="margin-bottom: 12px">
          <button
            class="toggle-btn"
            :class="{ active: obsProvider === 'builtin' }"
            @click="obsProvider = 'builtin'"
          >
            Builtin (Docker Compose)
          </button>
          <button
            class="toggle-btn"
            :class="{ active: obsProvider === 'custom' }"
            @click="obsProvider = 'custom'"
          >
            Custom stack
          </button>
        </div>

        <!-- Custom endpoints -->
        <div v-if="obsProvider === 'custom'" class="obs-custom-fields">
          <div class="form-group">
            <label>OTLP Endpoint</label>
            <input v-model="obsEndpoints.otlp" class="form-input" placeholder="http://tempo:4318" />
          </div>
          <div class="form-group">
            <label>Loki Endpoint</label>
            <input v-model="obsEndpoints.loki" class="form-input" placeholder="http://loki:3100" />
          </div>
          <div class="form-group">
            <label>Grafana URL</label>
            <input v-model="obsEndpoints.grafana" class="form-input" placeholder="http://grafana:3000" />
          </div>
        </div>
      </div>

      <div class="step-actions">
        <button class="btn-secondary" @click="step = 2">← Zpět</button>
        <button class="btn-primary" :disabled="completing" @click="complete">
          <span v-if="completing">Spouštím...</span>
          <span v-else>Spustit systém →</span>
        </button>
      </div>
    </div>

    <!-- Step 4: Done -->
    <div v-if="step === 4" class="wizard-step wizard-done">
      <div class="done-icon">✅</div>
      <h2>Systém je připraven!</h2>
      <p>Přesměrovávám na dashboard...</p>
    </div>

    <div v-if="globalError" class="global-error">{{ globalError }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, watch } from 'vue'

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

// Reset oauth state when switching provider type
watch(providerType, () => {
  oauthState.value = 'idle'
  oauthUrl.value = ''
  oauthClicked.value = false
  apiKeyError.value = ''
})

// Hub catalog
type CatalogItem = { id: string; name: string; description: string; requires: Array<{key:string;label:string;type:string;placeholder?:string;help?:string;shared?:boolean}> }
const catalog = ref<{ teams: CatalogItem[]; agents: CatalogItem[] }>({ teams: [], agents: [] })
const catalogLoading = ref(false)
const expandedItem = ref<string | null>(null)
const itemConfigs = ref<Record<string, Record<string, unknown>>>({})
const installedItems = ref<string[]>([])
const installingItem = ref<string | null>(null)
const installErrors = ref<Record<string, string>>({})
const sshGenerating = ref<Record<string, boolean>>({})
const sshPublicKeys = ref<Record<string, string>>({})
const copied = ref(false)

// Observability config (step 3)
const obsLevel = ref<'none' | 'logging' | 'full'>('full')
const obsProvider = ref<'builtin' | 'custom'>('builtin')
const obsEndpoints = reactive({
  otlp: 'http://tempo:4318',
  loki: 'http://loki:3100',
  grafana: 'http://localhost:3000',
})
const obsOptions = [
  { value: 'none' as const, label: 'None', icon: '⏸️', desc: 'Bez observability. Nulový overhead.' },
  { value: 'logging' as const, label: 'Logging', icon: '📋', desc: 'Centralizované logy (Loki + Grafana). Bez tracingu.' },
  { value: 'full' as const, label: 'Full', icon: '🔍', desc: 'Distributed tracing + logy (Tempo + Loki + Grafana + Alloy).' },
]

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

  // Restore progress — if provider is already configured, skip to step 2
  try {
    const res = await fetch('/api/config')
    const config = await res.json() as { provider?: { type?: string }; installed?: { teams?: string[]; features?: string[] } }
    if (config.provider?.type) {
      await loadCatalog()
      // Restore already installed items
      const done = [...(config.installed?.teams ?? []), ...(config.installed?.features ?? [])]
      if (done.length > 0) installedItems.value = done
      step.value = 2
    }
  } catch { /* ignore */ }

  // Listen for SSE auth-completed
  eventSource = new EventSource('/api/events')
  eventSource.addEventListener('auth-completed', () => {
    oauthState.value = 'done'
    void proceedAfterOauth()
  })
})

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
    codexLoginLoading.value = true
    codexLoginStatus.value = ''
    try {
      const res = await fetch('/api/auth/codex-login', { method: 'POST' })
      const data = await res.json() as { success?: boolean; message?: string; error?: string }

      if (data.success) {
        codexLoginStatus.value = '✅ ' + (data.message || 'Codex je přihlášen!')
        // Wait a moment, then proceed
        await new Promise(r => setTimeout(r, 1500))
        await proceedAfterCodexLogin()
        return
      }

      // If not successful, show error/instruction
      apiKeyError.value = data.error || data.message || 'Chyba při Codex loginu'
    } catch (err) {
      apiKeyError.value = `Chyba: ${String(err)}`
    } finally {
      codexLoginLoading.value = false
    }
    return
  }

  // Handle Claude
  if (selectedProvider.value === 'claude' && providerType.value === 'claude-code') {
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

    await loadCatalog()
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
    await loadCatalog()
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
    await loadCatalog()
    step.value = 2
  } catch (err) {
    apiKeyError.value = `Chyba při ukládání: ${String(err)}`
  }
}

async function loadCatalog() {
  catalogLoading.value = true
  try {
    const res = await fetch('/api/hub/catalog')
    if (res.ok) {
      catalog.value = await res.json() as typeof catalog.value
    }
  } catch { /* ignore */ } finally {
    catalogLoading.value = false
  }
}

function toggleItem(id: string) {
  expandedItem.value = expandedItem.value === id ? null : id
}

function setItemConfig(itemId: string, key: string, value: unknown) {
  if (!itemConfigs.value[itemId]) itemConfigs.value[itemId] = {}
  itemConfigs.value[itemId][key] = value
}

async function generateSsh(teamId: string) {
  sshGenerating.value[teamId] = true
  try {
    const res = await fetch('/api/hub/generate-ssh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId }),
    })
    const data = await res.json() as { publicKey?: string; error?: string }
    if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`)
    sshPublicKeys.value[teamId] = data.publicKey ?? ''
    setItemConfig(teamId, 'ssh_key_generated', true)
  } catch (err) {
    installErrors.value[teamId] = String(err)
  } finally {
    sshGenerating.value[teamId] = false
  }
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Fallback for non-HTTPS contexts
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

function deployKeyUrl(itemId: string): string | null {
  const key = sshPublicKeys.value[itemId] ?? ''
  if (!key) return null
  const params = new URLSearchParams({ title: 'nano-agent-team', key })
  return `https://github.com/settings/ssh/new?${params}`
}

async function installItem(item: CatalogItem) {
  installingItem.value = item.id
  installErrors.value[item.id] = ''
  try {
    const res = await fetch('/api/hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [item.id], config: itemConfigs.value[item.id] ?? {} }),
    })
    const data = await res.json() as { ok?: boolean; error?: string; errors?: Array<{id:string;error:string}> }
    if (!res.ok || !data.ok) {
      const msg = data.errors?.[0]?.error ?? data.error ?? `HTTP ${res.status}`
      throw new Error(msg)
    }
    installedItems.value.push(item.id)
  } catch (err) {
    installErrors.value[item.id] = String(err)
  } finally {
    installingItem.value = null
  }
}

async function complete() {
  completing.value = true
  globalError.value = ''
  try {
    // Save observability config first
    if (obsLevel.value !== 'none') {
      const obsBody: Record<string, unknown> = {
        level: obsLevel.value,
        provider: obsProvider.value,
      }
      if (obsProvider.value === 'custom') {
        obsBody.endpoints = { ...obsEndpoints }
      }
      const obsRes = await fetch('/api/observability/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obsBody),
      })
      if (!obsRes.ok) {
        const data = await obsRes.json() as { error?: string }
        console.warn('Observability config warning:', data.error)
        // Non-fatal — continue with setup
      }
    }

    // Save observability level to main config (for core tracing init)
    await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        observability: {
          level: obsLevel.value,
          provider: obsProvider.value,
          endpoints: obsProvider.value === 'custom' ? { ...obsEndpoints } : {
            otlp: 'http://tempo:4318',
            loki: 'http://loki:3100',
            grafana: 'http://localhost:3000',
          },
        },
      }),
    })

    const res = await fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install: installedItems.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    step.value = 4
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

/* Wide step for catalog */
.wizard-step--wide { max-width: 560px; }

/* Catalog loading */
.catalog-loading {
  text-align: center;
  color: var(--text-muted, #8b949e);
  font-size: 13px;
  padding: 20px;
}

/* Catalog cards */
.catalog-card {
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  margin-bottom: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s;
}

.catalog-card:hover { border-color: var(--accent, #58a6ff); }
.catalog-card--expanded { border-color: var(--accent, #58a6ff); }

.catalog-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
}

.catalog-card-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.catalog-card-chevron {
  font-size: 11px;
  color: var(--text-muted, #8b949e);
  flex-shrink: 0;
}

.catalog-card-desc {
  font-size: 12px;
  color: var(--text-muted, #8b949e);
  margin: 0 14px 10px;
  line-height: 1.5;
}

.badge-installed {
  font-size: 11px;
  color: var(--accent2, #3fb950);
  background: rgba(63, 185, 80, 0.1);
  border: 1px solid rgba(63, 185, 80, 0.3);
  border-radius: 4px;
  padding: 1px 6px;
}

/* Requires form (inside expanded card) */
.requires-form {
  border-top: 1px solid var(--border, #30363d);
  padding: 16px 14px;
  background: var(--bg, #0d1117);
}

.field-help {
  font-size: 12px;
  color: var(--text-muted, #8b949e);
  margin: 0 0 8px;
  line-height: 1.5;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 13px;
}

.btn-install {
  margin-top: 12px;
}

/* SSH field */
.ssh-field { display: flex; flex-direction: column; gap: 12px; }

.ssh-result { display: flex; flex-direction: column; gap: 8px; }

.btn-copy {
  align-self: flex-start;
  padding: 5px 10px;
  background: transparent;
  color: var(--text-muted, #8b949e);
  border: 1px solid var(--border, #30363d);
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.btn-copy:hover { border-color: var(--text-muted, #8b949e); }

.ssh-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.btn-github {
  display: inline-block;
  padding: 5px 10px;
  background: rgba(88, 166, 255, 0.1);
  color: var(--accent, #58a6ff);
  border: 1px solid var(--accent, #58a6ff);
  border-radius: 5px;
  font-size: 12px;
  text-decoration: none;
  transition: background 0.15s;
}

.btn-github:hover { background: rgba(88, 166, 255, 0.2); text-decoration: none; }

/* Checkbox label */
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  cursor: pointer;
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

/* Observability cards */
.obs-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 20px;
}

.obs-card {
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 12px 14px;
  cursor: pointer;
  transition: all 0.15s;
}

.obs-card:hover { border-color: var(--accent, #58a6ff); }

.obs-card--active {
  border-color: var(--accent, #58a6ff);
  background: rgba(88, 166, 255, 0.08);
}

.obs-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.obs-card-icon { font-size: 16px; }
.obs-card-title { font-weight: 600; font-size: 14px; }

.obs-card-badge {
  font-size: 10px;
  background: rgba(88, 166, 255, 0.15);
  border: 1px solid var(--accent, #58a6ff);
  color: var(--accent, #58a6ff);
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.obs-card-desc {
  font-size: 12px;
  color: var(--text-muted, #8b949e);
  margin: 6px 0 0;
  line-height: 1.4;
}

.obs-provider-section {
  margin-bottom: 20px;
}

.obs-custom-fields {
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 14px;
}

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
