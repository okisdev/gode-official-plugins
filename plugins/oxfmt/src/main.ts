import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer(() => ({
  project: [
    { path: 'node_modules/.bin/vp', args: ['fmt', '--lsp'] },
    { path: 'node_modules/.bin/oxfmt', args: ['--lsp'] },
  ],
}))
