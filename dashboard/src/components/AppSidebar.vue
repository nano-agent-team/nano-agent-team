<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="sidebar-header">
      <span class="brand-icon">🤖</span>
      <span class="brand-text" v-show="!collapsed">nano-agent-team</span>
      <button class="toggle-btn" @click="collapsed = !collapsed" :title="collapsed ? 'Rozbalit menu' : 'Sbalit menu'">
        {{ collapsed ? '›' : '‹' }}
      </button>
    </div>

    <nav class="sidebar-nav">
      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        :class="['nav-item', isActive(item.path) ? 'active' : '']"
        :title="collapsed ? item.label : ''"
      >
        <span class="nav-icon">{{ item.icon }}</span>
        <span class="nav-label" v-show="!collapsed">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <div class="sidebar-footer">
      <span class="status-dot" :class="connected ? 'ok' : 'err'" :title="connected ? 'Připojeno' : 'Offline'">●</span>
      <span class="status-text" v-show="!collapsed">{{ connected ? 'live' : 'offline' }}</span>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { module as coreModule } from '../modules/core/module.config'
import { module as soulModule } from '../modules/soul/module.config'

const route = useRoute()
const collapsed = ref(false)
const connected = ref(true)

// Core nav items — Thinking is primary, Settings via plugins
const coreNavItems = [
  { path: '/soul', label: soulModule.label, icon: soulModule.icon },
]

// Plugin metadata from /api/plugins — fully dynamic, no hardcoding
interface PluginRoute { path: string; component: string; nav?: { label: string; icon: string } }
interface PluginMeta { id: string; name: string; uiEntry: string | null; routes: PluginRoute[] }
const pluginMeta = inject<PluginMeta[]>('pluginMeta', [])

const pluginNavItems = computed(() => {
  const seen = new Set<string>()
  const items: { path: string; label: string; icon: string }[] = []
  for (const plugin of pluginMeta) {
    for (const r of plugin.routes ?? []) {
      if (r.nav && !seen.has(r.path)) {
        seen.add(r.path)
        items.push({ path: r.path, label: r.nav.label, icon: r.nav.icon })
      }
    }
  }
  return items
})

const navItems = computed(() => [...coreNavItems, ...pluginNavItems.value])

function isActive(path: string): boolean {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}

// Health check
let pingInterval: ReturnType<typeof setInterval>

async function checkHealth() {
  try {
    const res = await fetch('/api/health')
    connected.value = res.ok
  } catch {
    connected.value = false
  }
}

onMounted(() => {
  checkHealth()
  pingInterval = setInterval(checkHealth, 30000)
})
onUnmounted(() => clearInterval(pingInterval))
</script>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: 200px;
  min-width: 200px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  transition: width 0.2s ease, min-width 0.2s ease;
  overflow: hidden;
  flex-shrink: 0;
}

.sidebar.collapsed {
  width: 48px;
  min-width: 48px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 10px;
  border-bottom: 1px solid var(--border);
  min-height: 48px;
}

.brand-icon { font-size: 18px; flex-shrink: 0; }

.brand-text {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 0.5px;
  white-space: nowrap;
  overflow: hidden;
  flex: 1;
}

.toggle-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 4px;
  border-radius: 3px;
  line-height: 1;
  flex-shrink: 0;
}
.toggle-btn:hover { color: var(--text); background: var(--surface2); }

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 6px;
  flex: 1;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--text-muted);
  text-decoration: none;
  transition: background 0.1s, color 0.1s;
  white-space: nowrap;
  overflow: hidden;
}
.nav-item:hover {
  background: var(--surface2);
  color: var(--text);
  text-decoration: none;
}
.nav-item.active {
  background: var(--surface2);
  color: var(--accent);
}

.nav-icon { font-size: 15px; flex-shrink: 0; }
.nav-label { overflow: hidden; }

.sidebar-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
}

.status-dot {
  font-size: 10px;
  flex-shrink: 0;
}
.status-dot.ok { color: var(--accent2); }
.status-dot.err { color: var(--danger); }

.status-text {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.5px;
  white-space: nowrap;
}
</style>
