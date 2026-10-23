import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => ({
  kind: 'program',
  path: join(paths.plugin, 'server', 'node_modules', 'bash-language-server', 'out', 'cli.js'),
  args: ['start'],
}))
