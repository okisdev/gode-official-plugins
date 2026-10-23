import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => ({
  kind: 'program',
  path: join(paths.plugin, 'bin', 'buf'),
  args: ['lsp', 'serve'],
  env: { XDG_CACHE_HOME: join(paths.data, 'cache') },
}))
