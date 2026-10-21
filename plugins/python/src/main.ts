import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => ({
  kind: 'script',
  path: join(paths.plugin, 'server', 'node_modules', 'basedpyright', 'langserver.index.js'),
  args: [],
}))
