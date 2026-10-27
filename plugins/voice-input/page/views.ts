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
    kind: 'terms',
    title: 'view.memory',
    description: 'view.memory.description',
    add: { id: 'addTerm', placeholder: 'view.memory.add' },
    remove: { id: 'forgetTerm', title: 'action.forgetTerm' },
    actions: ['clearMemory'],
  },
  {
    id: 'suggestions',
    kind: 'list',
    title: 'view.suggestions',
    description: 'view.suggestions.description',
    itemActions: [
      { id: 'acceptSuggestion', title: 'action.acceptSuggestion' },
      { id: 'ignoreSuggestion', title: 'action.ignoreSuggestion', destructive: true },
    ],
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
