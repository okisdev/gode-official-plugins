import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

defineLanguageServer(
  (paths) => ({
    kind: 'program',
    path: join(paths.plugin, 'bin', 'tsc'),
    args: ['--lsp', '--stdio'],
  }),
  { ready: 'ready', failed: 'failed' },
)
