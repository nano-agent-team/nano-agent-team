import type { RouteRecordRaw } from 'vue-router'

export const module = {
  id: 'core',
  label: 'Domů',
  icon: '🏠',
  routes: [
    {
      path: '/',
      redirect: '/soul',
    },
  ] as RouteRecordRaw[],
}
