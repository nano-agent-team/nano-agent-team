import { createApp, defineAsyncComponent } from 'vue'
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import App from './App.vue'
import './assets/main.css'

// Import built-in core module only
import { module as coreModule } from './modules/core/module.config'

// ── Plugin discovery ───────────────────────────────────────────────────────
// Fetch plugin list from core Express — used only to know which plugins are
// installed so AppNav can render navigation links.
// The actual Vue components are loaded via Module Federation at route-level.

interface PluginMeta {
  id: string
  name: string
  uiEntry: string | null
}

interface ConfigStatus {
  complete: boolean
  setupCompleted: boolean
  missing: string[]
}

async function fetchPlugins(): Promise<PluginMeta[]> {
  try {
    const res = await fetch('/api/plugins')
    if (!res.ok) return []
    return res.json() as Promise<PluginMeta[]>
  } catch {
    return []
  }
}

async function fetchSetupStatus(): Promise<ConfigStatus> {
  try {
    const res = await fetch('/api/config/status')
    if (!res.ok) return { complete: false, setupCompleted: false, missing: [] }
    return res.json() as Promise<ConfigStatus>
  } catch {
    return { complete: false, setupCompleted: false, missing: [] }
  }
}

// ── Plugin routes (Module Federation) ────────────────────────────────────
// Each known plugin is wired as a lazy federation import.
function buildPluginRoutes(): RouteRecordRaw[] {
  return [
    {
      path: '/tickets',
      component: defineAsyncComponent(() =>
        import('devTeamPlugin/TicketsView').then((m) => m.default ?? m),
      ),
    },
    {
      path: '/settings',
      component: defineAsyncComponent(() =>
        import('settingsPlugin/SettingsView').then((m) => m.default ?? m),
      ),
    },
  ]
}

async function bootstrap() {
  // Check setup status first
  const setupStatus = await fetchSetupStatus()

  // If setup is not complete, show SetupWizard as a full-page gate
  if (!setupStatus.complete) {
    const SetupWizard = defineAsyncComponent(() =>
      import('settingsPlugin/SetupWizard').then((m) => m.default ?? m),
    )
    const setupRouter = createRouter({
      history: createWebHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: SetupWizard }],
    })
    const setupApp = createApp(SetupWizard)
    setupApp.use(setupRouter)
    setupApp.mount('#app')
    return
  }

  // Normal mode — fetch plugin metadata for AppNav
  const plugins = await fetchPlugins()

  const routes: RouteRecordRaw[] = [
    ...coreModule.routes,
    ...buildPluginRoutes(),
  ]

  const router = createRouter({
    history: createWebHistory(),
    routes,
  })

  const app = createApp(App)
  app.use(router)

  // Provide plugin metadata to all components (used by AppNav)
  app.provide('pluginMeta', plugins)

  app.mount('#app')

  // Listen for SSE plugins-updated event (after setup_complete or live install)
  listenForReload(router, plugins)
}

function listenForReload(router: ReturnType<typeof createRouter>, plugins: PluginMeta[]) {
  try {
    const es = new EventSource('/api/events')

    es.addEventListener('system', (e) => {
      const event = JSON.parse(e.data) as { type: string }
      if (event.type === 'plugins-updated') {
        // Refresh the page — simplest way to pick up new routes
        window.location.reload()
      }
    })

    es.addEventListener('setup-completed', () => {
      window.location.reload()
    })
  } catch { /* SSE not critical */ }
}

void bootstrap()
