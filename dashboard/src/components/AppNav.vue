<template>
  <nav class="app-nav">
    <div class="nav-brand">
      <span class="brand-icon">🤖</span>
      <span class="brand-text">nano-agent-team</span>
    </div>
    <div class="nav-links">
      <RouterLink
        v-for="mod in modules"
        :key="mod.id"
        :to="mod.routes[0].path as string"
        :class="['nav-link', isActive(mod.routes[0].path as string) ? 'active' : '']"
      >
        <span class="nav-icon">{{ mod.icon }}</span>
        <span class="nav-label">{{ mod.label }}</span>
      </RouterLink>
    </div>
    <div class="nav-right">
      <span class="nav-status" :class="connected ? 'ok' : 'err'">
        {{ connected ? '● live' : '○ offline' }}
      </span>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { module as coreModule } from '../modules/core/module.config'
import { module as ticketsModule } from '../modules/tickets/module.config'

const modules = [coreModule, ticketsModule]
const route = useRoute()
const connected = ref(true)

function isActive(path: string): boolean {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}

// Check connectivity
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
.app-nav {
  display: flex;
  align-items: center;
  height: 40px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 16px;
  gap: 16px;
  flex-shrink: 0;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 8px;
}

.brand-icon { font-size: 18px; }

.brand-text {
  font-size: 13px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 1px;
}

.nav-links {
  display: flex;
  gap: 4px;
  flex: 1;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-muted);
  text-decoration: none;
  transition: background 0.1s, color 0.1s;
}

.nav-link:hover {
  background: var(--surface2);
  color: var(--text);
  text-decoration: none;
}

.nav-link.active {
  background: var(--surface2);
  color: var(--accent);
}

.nav-icon { font-size: 14px; }
.nav-label { }

.nav-right {
  margin-left: auto;
}

.nav-status {
  font-size: 11px;
  letter-spacing: 1px;
}

.nav-status.ok { color: var(--accent2); }
.nav-status.err { color: var(--danger); }
</style>
