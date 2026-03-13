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

async function fetchPlugins(): Promise<PluginMeta[]> {
  try {
    const res = await fetch('/api/plugins')
    if (!res.ok) return []
    return res.json() as Promise<PluginMeta[]>
  } catch {
    return []
  }
}

// ── Plugin routes (Module Federation) ────────────────────────────────────
// Each known plugin is wired as a lazy federation import.
// Extend this map when adding more plugins.
function buildPluginRoutes(): RouteRecordRaw[] {
  return [
    {
      path: '/tickets',
      component: defineAsyncComponent(() =>
        import('devTeamPlugin/TicketsView').then((m) => m.default ?? m),
      ),
    },
  ]
}

async function bootstrap() {
  // Fetch plugin metadata (used by AppNav for nav links)
  const plugins = await fetchPlugins()
  // Expose to AppNav without window pollution — store on app instance
  const pluginMeta = plugins

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

  // Provide plugin metadata to all components
  app.provide('pluginMeta', pluginMeta)

  app.mount('#app')
}

void bootstrap()
