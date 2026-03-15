<template>
  <div class="settings-view">
    <div class="settings-header">
      <h1>⚙️ Settings</h1>
    </div>

    <!-- ── Tab: Hub ─────────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'hub'" class="settings-body">
      <div class="settings-section">
        <h2>Hub — Katalog</h2>
        <div v-if="catalogLoading" class="loading">Načítám katalog...</div>
        <div v-else-if="catalogError" class="error-msg">{{ catalogError }}</div>
        <div v-else>
          <div v-if="catalog.teams.length === 0 && catalog.agents.length === 0" class="empty-installed">
            Katalog je prázdný nebo nedostupný.
          </div>

          <template v-if="catalog.teams.length > 0">
            <h3 class="catalog-group-label">Týmy</h3>
          </template>

          <div
            v-for="item in catalog.teams"
            :key="item.id"
            :class="['catalog-card', expandedItem === item.id ? 'catalog-card--expanded' : '']"
          >
            <div class="catalog-card-header" @click="toggleItem(item.id)">
              <div class="catalog-card-info">
                <span class="catalog-name">{{ item.name }}</span>
                <span class="catalog-type">{{ item.type === 'team' ? 'Tým' : 'Agent' }}</span>
                <span v-if="installedItems.includes(item.id)" class="badge-installed">✓ Nainstalováno</span>
              </div>
              <span class="catalog-toggle">{{ expandedItem === item.id ? '▲' : '▼' }}</span>
            </div>

            <div v-if="expandedItem === item.id" class="requires-form">
              <p v-if="item.description" class="item-desc">{{ item.description }}</p>

              <div v-for="field in item.requires" :key="field.key" class="field-row">
                <label class="field-label">{{ field.label }}</label>

                <!-- SSH generate -->
                <div v-if="field.type === 'generate_ssh'" class="ssh-field">
                  <button
                    class="btn-secondary"
                    :disabled="sshGenerating === item.id"
                    @click="generateSsh(item.id)"
                  >
                    {{ sshGenerating === item.id ? 'Generuji...' : 'Vygenerovat klíč' }}
                  </button>
                  <div v-if="sshPublicKeys[item.id]" class="ssh-pubkey">
                    <code>{{ sshPublicKeys[item.id] }}</code>
                    <button class="btn-copy" @click="copyToClipboard(sshPublicKeys[item.id])">
                      {{ copied === item.id ? '✓' : 'Kopírovat' }}
                    </button>
                    <p class="ssh-hint">Přidej tento public key do GitHub Deploy Keys repozitáře.</p>
                  </div>
                </div>

                <!-- Boolean -->
                <input
                  v-else-if="field.type === 'boolean'"
                  type="checkbox"
                  :checked="!!itemConfigs[item.id]?.[field.key]"
                  @change="setItemConfig(item.id, field.key, ($event.target as HTMLInputElement).checked)"
                />

                <!-- Text / Password -->
                <input
                  v-else
                  :type="field.type === 'password' ? 'password' : 'text'"
                  :placeholder="field.placeholder ?? ''"
                  :value="itemConfigs[item.id]?.[field.key] ?? ''"
                  class="field-input"
                  @input="setItemConfig(item.id, field.key, ($event.target as HTMLInputElement).value)"
                />

                <p v-if="field.help" class="field-help">{{ field.help }}</p>
              </div>

              <div v-if="installErrors[item.id]" class="error-msg">{{ installErrors[item.id] }}</div>

              <div v-if="installingItem === item.id && installLog.length" class="install-log">
                <div v-for="(line, i) in installLog" :key="i" class="install-log-line">{{ line }}</div>
              </div>

              <button
                class="btn-primary"
                :disabled="installingItem === item.id || installedItems.includes(item.id)"
                @click="installItem(item)"
              >
                {{ installingItem === item.id ? '⏳ Instaluji...' : installedItems.includes(item.id) ? '✓ Nainstalováno' : 'Instalovat' }}
              </button>
            </div>
          </div>

          <template v-if="catalog.agents.length > 0">
            <h3 class="catalog-group-label" style="margin-top:16px">Standalone agenti</h3>
          </template>

          <div
            v-for="item in catalog.agents"
            :key="item.id"
            :class="['catalog-card', expandedItem === item.id ? 'catalog-card--expanded' : '']"
          >
            <div class="catalog-card-header" @click="toggleItem(item.id)">
              <div class="catalog-card-info">
                <span class="catalog-name">{{ item.name }}</span>
                <span class="catalog-type">Agent</span>
                <span v-if="installedItems.includes(item.id)" class="badge-installed">✓ Nainstalováno</span>
              </div>
              <span class="catalog-toggle">{{ expandedItem === item.id ? '▲' : '▼' }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Tab: Systém ──────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'system'" class="settings-body">
      <div class="settings-section">
        <h2>Stav systému</h2>
        <div class="status-row">
          <span class="status-label">Setup</span>
          <span :class="['status-badge', status.complete ? 'ok' : 'warn']">
            {{ status.complete ? 'Dokončen' : 'Nedokončen' }}
          </span>
        </div>
        <div class="status-row">
          <span class="status-label">Provider</span>
          <span class="status-value">{{ config?.provider?.type ?? '—' }}</span>
        </div>
        <div v-if="status.missing?.length" class="missing-list">
          <span class="missing-label">Chybí:</span>
          <code v-for="m in status.missing" :key="m" class="missing-item">{{ m }}</code>
        </div>
      </div>

      <!-- Multi-Provider Configuration -->
      <div class="settings-section">
        <h2>🔄 LLM Providery</h2>
        <p class="section-desc">Nakonfiguruj více LLM providerů a vyber primární. Agenti si mohou volit provider na základě svých schopností.</p>

        <!-- Primary Provider Selection -->
        <div class="field-row">
          <label class="field-label">Primární Provider</label>
          <div class="provider-selector">
            <button
              v-for="p in ['claude', 'codex', 'gemini']"
              :key="p"
              :class="['btn-provider', primaryProvider === p ? 'active' : '']"
              @click="primaryProvider = p"
            >
              {{ { claude: '🔴 Claude', codex: '🟠 Codex', gemini: '🔵 Gemini' }[p] }}
            </button>
          </div>
        </div>

        <!-- Claude Configuration -->
        <div class="provider-config">
          <h3>🔴 Claude</h3>
          <div class="field-row">
            <label class="field-label">Typ autentizace</label>
            <div class="auth-toggle">
              <button
                :class="['btn-toggle', claudeAuthType === 'oauth' ? 'active' : '']"
                @click="claudeAuthType = 'oauth'"
              >OAuth (Subscription)</button>
              <button
                :class="['btn-toggle', claudeAuthType === 'key' ? 'active' : '']"
                @click="claudeAuthType = 'key'"
              >API Key</button>
            </div>
          </div>
          <div v-if="claudeAuthType === 'key'" class="field-row">
            <label class="field-label">Anthropic API Key</label>
            <input
              v-model="claudeApiKey"
              type="password"
              placeholder="sk-ant-..."
              class="field-input"
              @blur="saveProviderConfig('claude')"
            />
            <p class="field-help">Přímý API klíč pro Anthropic. OAuth (subscription) se automaticky čte z ~/.claude/.credentials.json.</p>
          </div>
          <div v-else class="field-row">
            <p class="field-help">✓ Přihlášen přes Claude OAuth. Token se automaticky čte z ~/.claude/.credentials.json.</p>
          </div>
        </div>

        <!-- Codex Configuration -->
        <div class="provider-config">
          <h3>🟠 OpenAI Codex</h3>
          <div class="field-row">
            <label class="field-label">Typ autentizace</label>
            <div class="auth-toggle">
              <button
                :class="['btn-toggle', codexAuthType === 'subscription' ? 'active' : '']"
                @click="codexAuthType = 'subscription'"
              >ChatGPT Subscription</button>
              <button
                :class="['btn-toggle', codexAuthType === 'key' ? 'active' : '']"
                @click="codexAuthType = 'key'"
              >API Key</button>
            </div>
          </div>
          <div v-if="codexAuthType === 'key'" class="field-row">
            <label class="field-label">OpenAI API Key</label>
            <input
              v-model="codexApiKey"
              type="password"
              placeholder="sk-proj-..."
              class="field-input"
              @blur="saveProviderConfig('codex')"
            />
            <p class="field-help">Přímý API klíč z OpenAI. Subscription token se automaticky čte z ~/.codex/auth.json.</p>
          </div>
          <div v-else class="field-row">
            <button class="btn-secondary" @click="loginCodexSubscription" :disabled="codexLoginLoading">
              {{ codexLoginLoading ? '⏳ Přihlašuji...' : '🔐 Přihlásit se ChatGPT' }}
            </button>
            <p class="field-help" v-if="codexLoginStatus">{{ codexLoginStatus }}</p>
          </div>
        </div>

        <!-- Gemini Configuration -->
        <div class="provider-config">
          <h3>🔵 Google Gemini</h3>
          <div class="field-row">
            <label class="field-label">Google API Key</label>
            <input
              v-model="geminiApiKey"
              type="password"
              placeholder="AIza..."
              class="field-input"
              @blur="saveProviderConfig('gemini')"
            />
            <p class="field-help">API klíč z Google Cloud Console pro Gemini API.</p>
          </div>
        </div>

        <!-- Model Maps (Advanced) -->
        <details class="advanced-config">
          <summary>⚙️ Pokročilé: Model Mapping</summary>
          <div class="model-map-info">
            <p>Nastavte, který model se má použít pro každou schopnost (capability) a každého providera:</p>
            <ul>
              <li><strong>reasoning</strong> — komplexní analýza, dlouhé uvažování</li>
              <li><strong>long-context</strong> — práce s velkými texty</li>
              <li><strong>fast</strong> — rychlé jednoduchénní úkoly</li>
              <li><strong>cheap</strong> — cost-optimized operace</li>
              <li><strong>default</strong> — fallback model</li>
            </ul>
            <p class="field-help">Úpravy jsou dostupné v config.json na cestě <code>providers.{provider}.modelMap</code>.</p>
          </div>
        </details>
      </div>

      <div class="settings-section">
        <h2>Nainstalováno</h2>
        <div v-if="config?.installed?.teams?.length" class="installed-group">
          <span class="installed-label">Týmy:</span>
          <code v-for="t in config.installed.teams" :key="t" class="installed-item">{{ t }}</code>
        </div>
        <div v-if="config?.installed?.features?.length" class="installed-group">
          <span class="installed-label">Featury:</span>
          <code v-for="f in config.installed.features" :key="f" class="installed-item">{{ f }}</code>
        </div>
        <div v-if="!config?.installed?.teams?.length && !config?.installed?.features?.length"
             class="empty-installed">
          Nic nenainstalováno.
        </div>
      </div>

      <!-- Observability config -->
      <div class="settings-section">
        <h2>Observability</h2>
        <div class="obs-config">
          <div class="status-row">
            <span class="status-label">Level</span>
            <div class="obs-toggle">
              <button v-for="l in ['none','logging','full']" :key="l"
                :class="['btn-toggle', obsLevel === l ? 'active' : '']"
                @click="obsLevel = l"
              >{{ l }}</button>
            </div>
          </div>
          <div class="status-row">
            <span class="status-label">Provider</span>
            <div class="obs-toggle">
              <button v-for="p in ['builtin','custom']" :key="p"
                :class="['btn-toggle', obsProvider === p ? 'active' : '']"
                @click="obsProvider = p"
              >{{ p }}</button>
            </div>
          </div>
          <div v-if="obsProvider === 'custom'" class="obs-endpoints">
            <div class="field-row">
              <label class="field-label">OTLP Endpoint</label>
              <input v-model="obsEndpoints.otlp" class="field-input" placeholder="http://tempo:4318" />
            </div>
            <div class="field-row">
              <label class="field-label">Loki</label>
              <input v-model="obsEndpoints.loki" class="field-input" placeholder="http://loki:3100" />
            </div>
            <div class="field-row">
              <label class="field-label">Grafana</label>
              <input v-model="obsEndpoints.grafana" class="field-input" placeholder="http://localhost:3000" />
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
            <button class="btn-primary" :disabled="obsSaving" @click="saveObsConfig">
              {{ obsSaving ? 'Ukládám...' : 'Uložit' }}
            </button>
            <span v-if="obsSaved" class="obs-saved">✓ Uloženo</span>
            <span v-if="obsError" class="error-msg" style="margin:0">{{ obsError }}</span>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>Asistent</h2>
        <p class="section-desc">Zeptej se na cokoliv ohledně nastavení systému.</p>
        <div class="chat-messages" ref="chatEl">
          <div v-for="(msg, i) in messages" :key="i" :class="['chat-msg', msg.role]">
            <span class="chat-role">{{ msg.role === 'user' ? 'Ty' : '🤖' }}</span>
            <span class="chat-text">{{ msg.text }}</span>
          </div>
          <div v-if="thinking" class="chat-msg assistant thinking">
            <span class="chat-role">🤖</span>
            <span class="chat-text">...</span>
          </div>
        </div>
        <div class="chat-input-row">
          <input
            v-model="chatInput"
            type="text"
            placeholder="Napiš zprávu..."
            class="chat-input"
            :disabled="thinking"
            @keyup.enter="sendMessage"
          />
          <button class="btn-send" :disabled="thinking || !chatInput.trim()" @click="sendMessage">
            Odeslat
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, nextTick } from 'vue'

interface Message { role: 'user' | 'assistant'; text: string }
interface ConfigStatus { complete: boolean; missing: string[]; setupCompleted: boolean }
interface CatalogField {
  key: string; label: string; type: string;
  placeholder?: string; help?: string; shared?: boolean
}
interface CatalogItem {
  id: string; name: string; type: 'team' | 'agent';
  description?: string; requires: CatalogField[]
}
interface Catalog { teams: CatalogItem[]; agents: CatalogItem[] }
interface NanoConfig {
  provider?: { type?: string }
  installed?: { teams?: string[]; features?: string[] }
  primaryProvider?: string
  providers?: {
    claude?: { apiKey?: string }
    codex?: { apiKey?: string }
    gemini?: { apiKey?: string }
  }
}

const tabs = [
  { id: 'hub', label: '🛒 Hub' },
  { id: 'system', label: '⚙️ Systém' },
]
const activeTab = ref(window.location.pathname === '/settings' ? 'system' : 'hub')

const config = ref<NanoConfig | null>(null)
const status = ref<ConfigStatus>({ complete: false, missing: [], setupCompleted: false })

// Hub catalog
const catalog = ref<Catalog>({ teams: [], agents: [] })
const catalogLoading = ref(false)
const catalogError = ref('')
const expandedItem = ref<string | null>(null)
const itemConfigs = ref<Record<string, Record<string, unknown>>>({})
const installedItems = ref<string[]>([])
const installingItem = ref<string | null>(null)
const installErrors = ref<Record<string, string>>({})
const installLog = ref<string[]>([])
const sshGenerating = ref<string | null>(null)
const sshPublicKeys = ref<Record<string, string>>({})
const copied = ref<string | null>(null)

// Multi-Provider Configuration
const primaryProvider = ref('claude')
const claudeAuthType = ref('oauth')
const claudeApiKey = ref('')
const codexAuthType = ref('subscription')
const codexApiKey = ref('')
const codexLoginLoading = ref(false)
const codexLoginStatus = ref('')
const geminiApiKey = ref('')

// Observability
const obsLevel = ref('none')
const obsProvider = ref('builtin')
const obsEndpoints = reactive({ otlp: 'http://tempo:4318', loki: 'http://loki:3100', grafana: 'http://localhost:3000' })
const obsSaving = ref(false)
const obsSaved = ref(false)
const obsError = ref('')

// Chat
const messages = ref<Message[]>([])
const chatInput = ref('')
const thinking = ref(false)
const chatEl = ref<HTMLElement | null>(null)
const sessionId = `settings-${Date.now()}`

onMounted(async () => {
  await Promise.all([loadConfig(), loadStatus(), loadCatalog(), loadObsConfig()])
  messages.value.push({
    role: 'assistant',
    text: 'Ahoj! Jsem tvůj settings asistent. Zeptej se mě na cokoliv ohledně konfigurace nebo instalace.',
  })
})

async function loadConfig() {
  try {
    const res = await fetch('/api/config')
    if (res.ok) {
      config.value = await res.json() as NanoConfig
      primaryProvider.value = config.value.primaryProvider ?? 'claude'
      claudeApiKey.value = config.value.providers?.claude?.apiKey ?? ''
      codexApiKey.value = config.value.providers?.codex?.apiKey ?? ''
      geminiApiKey.value = config.value.providers?.gemini?.apiKey ?? ''
    }
  } catch { /* ignore */ }
}

async function loadStatus() {
  try {
    const res = await fetch('/api/config/status')
    if (res.ok) status.value = await res.json() as ConfigStatus
  } catch { /* ignore */ }
}

async function loadCatalog() {
  catalogLoading.value = true
  catalogError.value = ''
  try {
    const res = await fetch('/api/hub/catalog')
    if (!res.ok) { catalogError.value = `Chyba ${res.status}: ${res.statusText}`; return }
    catalog.value = await res.json() as Catalog
    // Mark already installed
    installedItems.value = [
      ...(config.value?.installed?.teams ?? []),
      ...(config.value?.installed?.features ?? []),
    ]
  } catch (e) {
    catalogError.value = String(e)
  } finally {
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

async function generateSsh(itemId: string) {
  sshGenerating.value = itemId
  try {
    const res = await fetch('/api/hub/generate-ssh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: itemId }),
    })
    const data = await res.json() as { publicKey?: string; error?: string }
    if (data.publicKey) sshPublicKeys.value[itemId] = data.publicKey
    else installErrors.value[itemId] = data.error ?? 'Chyba generování klíče'
  } catch (e) {
    installErrors.value[itemId] = String(e)
  } finally {
    sshGenerating.value = null
  }
}

async function copyToClipboard(text: string) {
  await navigator.clipboard.writeText(text)
  copied.value = text
  setTimeout(() => { copied.value = null }, 2000)
}

const STEP_LABELS: Record<string, string> = {
  'clone-team':    '📦 Stahuji manifest týmu',
  'clone-agent':   '🤖 Stahuji agenta',
  'clone-feature': '⚙️ Stahuji feature',
  'build':         '🔨 Stavím',
  'reload':        '🚀 Spouštím agenty',
  'done':          '✅ Hotovo',
}

async function installItem(item: CatalogItem) {
  installingItem.value = item.id
  installErrors.value[item.id] = ''
  installLog.value = []

  // Listen for progress via SSE
  const es = new EventSource('/api/events')
  es.addEventListener('hub-install-progress', (e) => {
    const d = JSON.parse(e.data) as { step: string; detail: string }
    const label = STEP_LABELS[d.step] ?? d.step
    installLog.value.push(d.detail ? `${label}: ${d.detail}` : label)
  })

  try {
    const res = await fetch('/api/hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [item.id],
        config: itemConfigs.value[item.id] ?? {},
      }),
    })
    const data = await res.json() as { ok?: boolean; installed?: string[]; error?: string; errors?: {id:string;error:string}[] }
    if (data.ok) {
      installedItems.value.push(item.id)
      expandedItem.value = null
      installLog.value = []
    } else {
      const errMsg = data.error ?? data.errors?.[0]?.error ?? 'Instalace selhala'
      installErrors.value[item.id] = errMsg
    }
  } catch (e) {
    installErrors.value[item.id] = String(e)
  } finally {
    es.close()
    installingItem.value = null
  }
}

async function loadObsConfig() {
  try {
    const res = await fetch('/api/observability/status')
    if (res.ok) {
      const data = await res.json() as { level: string; provider: string; endpoints: { otlp: string; loki: string; grafana: string } }
      obsLevel.value = data.level ?? 'none'
      obsProvider.value = data.provider ?? 'builtin'
      if (data.endpoints) Object.assign(obsEndpoints, data.endpoints)
    }
  } catch { /* ignore */ }
}

async function saveObsConfig() {
  obsSaving.value = true; obsError.value = ''; obsSaved.value = false
  try {
    const body: Record<string, unknown> = { level: obsLevel.value, provider: obsProvider.value }
    if (obsProvider.value === 'custom') body.endpoints = { ...obsEndpoints }
    const res = await fetch('/api/observability/configure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) { obsError.value = (await res.json() as { error: string }).error ?? 'Chyba'; return }
    obsSaved.value = true
    setTimeout(() => { obsSaved.value = false }, 3000)
  } catch (e) { obsError.value = String(e) }
  finally { obsSaving.value = false }
}

async function sendMessage() {
  const text = chatInput.value.trim()
  if (!text || thinking.value) return
  messages.value.push({ role: 'user', text })
  chatInput.value = ''
  thinking.value = true
  await scrollToBottom()
  try {
    const res = await fetch('/api/chat/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId }),
    })
    if (res.ok) {
      const data = await res.json() as { reply: unknown }
      const replyText = typeof data.reply === 'string' ? data.reply : JSON.stringify(data.reply)
      messages.value.push({ role: 'assistant', text: replyText })
      await loadConfig()
      await loadStatus()
    } else {
      messages.value.push({ role: 'assistant', text: '(Asistent není dostupný)' })
    }
  } catch {
    messages.value.push({ role: 'assistant', text: '(Chyba připojení)' })
  } finally {
    thinking.value = false
    await scrollToBottom()
  }
}

async function scrollToBottom() {
  await nextTick()
  if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
}

// Multi-Provider Functions
async function saveProviderConfig(provider: string) {
  try {
    const key = {
      claude: claudeApiKey.value,
      codex: codexApiKey.value,
      gemini: geminiApiKey.value,
    }[provider]

    if (key) {
      await fetch('/api/config/set-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: `providers.${provider}.apiKey`,
          value: key,
        }),
      })
    }
  } catch (e) {
    console.error(`Failed to save ${provider} config:`, e)
  }
}

async function loginCodexSubscription() {
  codexLoginLoading.value = true
  codexLoginStatus.value = 'Otevírám ChatGPT přihlášení...'
  try {
    // Call backend to initiate Codex auth flow
    const res = await fetch('/api/auth/codex-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json() as { success?: boolean; message?: string; error?: string }
    if (data.success) {
      codexLoginStatus.value = '✓ Přihlášen! Token uložen do ~/.codex/auth.json'
      codexAuthType.value = 'subscription'
    } else {
      codexLoginStatus.value = `Chyba: ${data.error ?? data.message ?? 'Přihlášení selhalo'}`
    }
  } catch (e) {
    codexLoginStatus.value = `Chyba: ${String(e)}`
  } finally {
    codexLoginLoading.value = false
  }
}
</script>

<style scoped>
.settings-view {
  padding: 24px;
  max-width: 720px;
  margin: 0 auto;
  color: var(--text, #e6edf3);
}

.settings-header h1 {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 12px;
}

.tab-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border, #30363d);
  padding-bottom: 0;
}

.tab-btn {
  padding: 8px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted, #8b949e);
  font-size: 13px;
  cursor: pointer;
  margin-bottom: -1px;
}
.tab-btn.active {
  color: var(--accent, #58a6ff);
  border-bottom-color: var(--accent, #58a6ff);
}
.tab-btn:hover { color: var(--text, #e6edf3); }

.settings-body { display: flex; flex-direction: column; gap: 16px; }

.settings-section {
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  padding: 20px;
}

.settings-section h2 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-muted, #8b949e);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 16px;
}

.loading { font-size: 13px; color: var(--text-muted, #8b949e); }
.catalog-group-label { font-size: 12px; font-weight: 600; color: var(--text-muted, #8b949e); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 8px; }
.error-msg { color: var(--danger, #f85149); font-size: 13px; margin: 8px 0; }

/* Catalog cards */
.catalog-card {
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  margin-bottom: 8px;
  overflow: hidden;
}
.catalog-card--expanded { border-color: var(--accent, #58a6ff); }

.catalog-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  cursor: pointer;
  background: var(--surface2, #1c2128);
}
.catalog-card-header:hover { background: #21262d; }

.catalog-card-info { display: flex; align-items: center; gap: 10px; }
.catalog-name { font-size: 14px; font-weight: 600; }
.catalog-type {
  font-size: 11px;
  background: rgba(88, 166, 255, 0.1);
  color: var(--accent, #58a6ff);
  padding: 2px 6px;
  border-radius: 4px;
}
.badge-installed {
  font-size: 11px;
  background: rgba(63, 185, 80, 0.1);
  color: var(--accent2, #3fb950);
  padding: 2px 6px;
  border-radius: 4px;
}
.catalog-toggle { font-size: 11px; color: var(--text-muted, #8b949e); }

.requires-form { padding: 16px; background: var(--bg, #0d1117); display: flex; flex-direction: column; gap: 12px; }
.item-desc { font-size: 13px; color: var(--text-muted, #8b949e); margin: 0; }

.field-row { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 12px; color: var(--text-muted, #8b949e); font-weight: 600; }
.field-help { font-size: 11px; color: var(--text-muted, #8b949e); margin: 0; }

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

.ssh-field { display: flex; flex-direction: column; gap: 8px; }
.ssh-pubkey { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; }
.ssh-pubkey code {
  font-size: 11px;
  background: var(--surface2, #1c2128);
  padding: 6px 10px;
  border-radius: 4px;
  word-break: break-all;
  flex: 1;
}
.ssh-hint { font-size: 11px; color: var(--text-muted, #8b949e); margin: 0; width: 100%; }

.install-log {
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 10px 12px;
  font-family: monospace;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 150px;
  overflow-y: auto;
}
.install-log-line { color: var(--accent2, #3fb950); }
.install-log-line:last-child { color: var(--text, #e6edf3); }

.btn-primary {
  align-self: flex-start;
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

.btn-copy {
  padding: 4px 10px;
  background: var(--surface2, #1c2128);
  color: var(--text-muted, #8b949e);
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
}

/* System tab */
.section-desc { font-size: 13px; color: var(--text-muted, #8b949e); margin: 0 0 12px; }
.status-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 13px; }
.status-label { color: var(--text-muted, #8b949e); min-width: 80px; }
.status-value { font-family: monospace; }
.status-badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.status-badge.ok { background: rgba(63, 185, 80, 0.15); color: var(--accent2, #3fb950); }
.status-badge.warn { background: rgba(210, 153, 34, 0.15); color: #d29922; }
.missing-list { margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.missing-label { color: var(--danger, #f85149); }
.missing-item { background: rgba(248, 81, 73, 0.1); color: var(--danger, #f85149); padding: 2px 6px; border-radius: 4px; }
.installed-group { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; font-size: 13px; }
.installed-label { color: var(--text-muted, #8b949e); min-width: 60px; }
.installed-item { background: var(--surface2, #1c2128); padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.empty-installed { font-size: 13px; color: var(--text-muted, #8b949e); }

.chat-messages {
  height: 200px; overflow-y: auto;
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 12px; margin-bottom: 12px;
  display: flex; flex-direction: column; gap: 8px;
}
.chat-msg { display: flex; gap: 8px; font-size: 13px; }
.chat-role { min-width: 24px; font-size: 11px; color: var(--text-muted, #8b949e); padding-top: 1px; }
.chat-msg.user .chat-text { color: var(--text, #e6edf3); }
.chat-msg.assistant .chat-text { color: var(--accent, #58a6ff); }
.chat-msg.thinking .chat-text { color: var(--text-muted, #8b949e); font-style: italic; }
.chat-input-row { display: flex; gap: 8px; }
.chat-input {
  flex: 1; padding: 8px 12px;
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  color: var(--text, #e6edf3);
  font-size: 13px; outline: none;
}
.chat-input:focus { border-color: var(--accent, #58a6ff); }
.btn-send {
  padding: 8px 16px;
  background: var(--accent, #58a6ff);
  color: #0d1117;
  border: none; border-radius: 6px;
  font-size: 13px; font-weight: 600; cursor: pointer;
}
.btn-send:disabled { opacity: 0.5; cursor: not-allowed; }

/* Observability config */
.obs-config { display: flex; flex-direction: column; gap: 12px; }
.obs-toggle { display: flex; gap: 4px; }
.btn-toggle {
  padding: 4px 12px; background: none; border: 1px solid var(--border, #30363d);
  border-radius: 4px; color: var(--text-muted, #8b949e); font-size: 12px; cursor: pointer;
}
.btn-toggle.active { background: rgba(88,166,255,0.1); border-color: var(--accent, #58a6ff); color: var(--accent, #58a6ff); }
.btn-toggle:hover { border-color: var(--text-muted, #8b949e); }
.obs-endpoints { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--bg, #0d1117); border-radius: 6px; }
.obs-saved { font-size: 12px; color: var(--accent2, #3fb950); }

/* Multi-Provider Configuration */
.provider-selector { display: flex; gap: 8px; margin: 12px 0; }
.btn-provider {
  flex: 1; padding: 10px 12px;
  background: var(--surface2, #1c2128);
  border: 2px solid var(--border, #30363d);
  border-radius: 6px;
  color: var(--text, #e6edf3);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn-provider.active {
  background: rgba(88,166,255,0.15);
  border-color: var(--accent, #58a6ff);
  color: var(--accent, #58a6ff);
}
.btn-provider:hover { border-color: var(--text-muted, #8b949e); }

.provider-config {
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 12px;
  margin: 12px 0;
}
.provider-config h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #e6edf3);
  margin: 0 0 12px;
}

.auth-toggle { display: flex; gap: 8px; }
.field-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text, #e6edf3);
}
.field-input {
  padding: 6px 12px;
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  color: var(--text, #e6edf3);
  font-size: 13px;
  outline: none;
}
.field-input:focus { border-color: var(--accent, #58a6ff); }
.field-help {
  font-size: 12px;
  color: var(--text-muted, #8b949e);
  margin: 4px 0 0;
}

.advanced-config {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  cursor: pointer;
}
.advanced-config summary {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  user-select: none;
}
.advanced-config summary:hover { color: var(--text, #e6edf3); }
.model-map-info {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-muted, #8b949e);
}
.model-map-info ul {
  margin: 8px 0;
  padding-left: 20px;
}
.model-map-info li { margin: 4px 0; }
</style>
