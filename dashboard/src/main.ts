import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './assets/main.css'

// Import modules (modular tab system)
import { module as coreModule } from './modules/core/module.config'
import { module as ticketsModule } from './modules/tickets/module.config'

const modules = [coreModule, ticketsModule]

// Build routes from all modules
const routes = modules.flatMap((mod) => mod.routes)

const router = createRouter({
  history: createWebHistory(),
  routes,
})

const app = createApp(App)
app.use(router)
app.mount('#app')
