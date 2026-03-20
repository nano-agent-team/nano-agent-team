import { createApp, defineAsyncComponent, type Component } from 'vue'
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import App from './App.vue'
import './assets/main.css'

import { module as coreModule } from './modules/core/module.config'

// ── Interfaces ────────────────────────────────────────────────────────────

interface PluginRoute {
  path: string
  component: string
  nav?: { label: string; icon: string }
}

interface PluginMeta {
  id: string
  name: string
  uiEntry: string | null
  routes: PluginRoute[]
}

interface ConfigStatus {
  complete: boolean
  setupCompleted: boolean
  missing: string[]
}

// ── Component registry ────────────────────────────────────────────────────
// Maps component name (from feature.json routes[].component) to a lazy loader.
// Only built-in federation remotes need to be listed here.
// New features installed from hub use the same names — extend this list if needed.

type LazyLoader = () => Promise<{ default: Component } | Component>

const componentRegistry: Record<string, LazyLoader> = {
  SettingsView: () =>
    import('settingsPlugin/SettingsView').then((m) => m.default ?? m),
  SimpleChatView: () =>
    import('simpleChatPlugin/SimpleChatView').then((m) => m.default ?? m),
  TicketsView: () =>
    import('issueTrackerPlugin/TicketsView')
      .catch(() => import('devTeamPlugin/TicketsView'))
      .then((m) => m.default ?? m),
  ObservabilityView: () =>
    import('observabilityPlugin/ObservabilityView').then((m) => m.default ?? m),

}

// ── Data fetching ─────────────────────────────────────────────────────────

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

// ── Dynamic route builder ─────────────────────────────────────────────────
// Derives routes from /api/plugins response — no hardcoding needed.

function buildPluginRoutes(plugins: PluginMeta[]): RouteRecordRaw[] {
  const routes: RouteRecordRaw[] = []
  const seen = new Set<string>()

  for (const plugin of plugins) {
    for (const r of plugin.routes ?? []) {
      if (seen.has(r.path)) continue
      const loader = componentRegistry[r.component]
      if (!loader) continue // unknown component — skip
      seen.add(r.path)
      routes.push({
        path: r.path,
        component: defineAsyncComponent(loader),
      })
    }
  }

  return routes
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function bootstrap() {
  const setupStatus = await fetchSetupStatus()

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

  const plugins = await fetchPlugins()

  const routes: RouteRecordRaw[] = [
    ...coreModule.routes,
    ...buildPluginRoutes(plugins),
  ]

  const router = createRouter({
    history: createWebHistory(),
    routes,
  })

  const app = createApp(App)
  app.use(router)
  app.provide('pluginMeta', plugins)
  app.mount('#app')

  listenForReload()
}

function listenForReload() {
  try {
    const es = new EventSource('/api/events')
    es.addEventListener('system', (e) => {
      const event = JSON.parse(e.data) as { type: string }
      if (event.type === 'plugins-updated') window.location.reload()
    })
    es.addEventListener('setup-completed', () => window.location.reload())
  } catch { /* SSE not critical */ }
}

void bootstrap()
