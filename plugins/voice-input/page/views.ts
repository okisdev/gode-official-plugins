import type { PluginViews } from '@gode/plugin-sdk'

export default [
  {
    id: 'history',
    kind: 'list',
    title: 'view.history',
    description: 'view.history.description',
    itemActions: [
      {
        id: 'deleteEntry',
        title: 'action.deleteEntry',
        destructive: true,
      },
    ],
    actions: ['clearHistory'],
  },
  {
    id: 'memory',
    kind: 'list',
    title: 'view.memory',
    description: 'view.memory.description',
    itemActions: [
      {
        id: 'forgetTerm',
        title: 'action.forgetTerm',
        destructive: true,
      },
    ],
    actions: ['clearMemory'],
  },
  {
    id: 'usage',
    kind: 'figures',
    title: 'view.usage',
  },
  {
    id: 'activity',
    kind: 'calendar',
    title: 'view.activity',
    description: 'view.activity.description',
  },
] as const satisfies PluginViews
