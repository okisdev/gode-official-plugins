import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => ({
  kind: 'program',
  path: join(paths.plugin, 'bin', 'biome'),
  args: ['lsp-proxy', `--log-path=${paths.data}`],
}))
