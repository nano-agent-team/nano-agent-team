import type { RouteRecordRaw } from 'vue-router'

export const module = {
  id: 'core',
  label: 'Domů',
  icon: '🏠',
  routes: [
    {
      path: '/',
      component: () => import('./HomeView.vue'),
    },
  ] as RouteRecordRaw[],
}
