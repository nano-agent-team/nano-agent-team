import type { RouteRecordRaw } from 'vue-router';

export const module = {
  id: 'soul',
  label: 'Thinking',
  icon: '🧠',
  routes: [
    {
      path: '/soul',
      component: () => import('./SoulView.vue'),
    },
  ] as RouteRecordRaw[],
};
