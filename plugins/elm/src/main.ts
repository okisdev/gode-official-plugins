import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => ({
  kind: 'program',
  path: join(
    paths.plugin,
    'server',
    'node_modules',
    '@elm-tooling',
    'elm-language-server',
    'out',
    'node',
    'index.js',
  ),
  args: ['--stdio'],
  initializationOptions: {
    treeSitterElmWasmUri: join(
      paths.plugin,
      'server',
      'node_modules',
      '@elm-tooling',
      'elm-language-server',
      'out',
      'tree-sitter-elm.wasm',
    ),
  },
}))
