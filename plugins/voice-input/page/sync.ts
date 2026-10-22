import type { PluginSync } from '@gode/plugin-sdk'

export default [
  { id: 'vocabulary', kind: 'map', title: 'sync.vocabulary', sync: 'syncTerms' },
  { id: 'terms', kind: 'map', title: 'sync.terms', sync: 'syncTerms' },
  { id: 'forgotten', kind: 'set', title: 'sync.forgotten', sync: 'syncTerms' },
] as const satisfies PluginSync
