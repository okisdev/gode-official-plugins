import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

defineLanguageServer(
  (paths) => ({
    kind: 'script',
    path: join(
      paths.plugin,
      'server',
      'node_modules',
      '@vue',
      'language-server',
      'bin',
      'vue-language-server.js',
    ),
    args: [],
    initializationOptions: {
      typescript: { tsdk: join(paths.plugin, 'server', 'node_modules', 'typescript', 'lib') },
      vue: { hybridMode: false },
    },
  }),
  { ready: 'ready', failed: 'failed' },
)
