import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => ({
  kind: 'script',
  path: join(
    paths.plugin,
    'server',
    'node_modules',
    'vscode-langservers-extracted',
    'lib',
    'css-language-server',
    'node',
    'cssServerNodeMain.js',
  ),
  args: [],
}))
