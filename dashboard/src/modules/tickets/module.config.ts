import type { RouteRecordRaw } from 'vue-router'

export const module = {
  id: 'tickets',
  label: 'Tickety',
  icon: '📋',
  routes: [
    {
      path: '/tickets',
      component: () => import('./TicketsView.vue'),
    },
  ] as RouteRecordRaw[],
}
