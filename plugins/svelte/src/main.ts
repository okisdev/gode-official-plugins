import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

defineLanguageServer(
  (paths) => ({
    kind: 'script',
    path: join(
      paths.plugin,
      'server',
      'node_modules',
      'svelte-language-server',
      'bin',
      'server.js',
    ),
    args: [],
  }),
  { ready: 'ready', failed: 'failed' },
)
