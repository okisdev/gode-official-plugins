import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => ({
  kind: 'script',
  path: join(
    paths.plugin,
    'server',
    'node_modules',
    '@nomicfoundation',
    'solidity-language-server',
    'out',
    'index.js',
  ),
  args: [],
}))
