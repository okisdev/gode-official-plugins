import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => ({
  kind: 'program',
  path: join(
    paths.plugin,
    'server',
    'node_modules',
    'graphql-language-service-cli',
    'bin',
    'graphql.js',
  ),
  args: ['server', '-m', 'stream'],
}))
