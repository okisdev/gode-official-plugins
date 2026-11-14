import { expect, startPlugin, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test('offers only the project’s Vite+ or Oxfmt server, in that order', async () => {
  const running = await startPlugin(plugin)
  expect(running.status).toEqual({ state: 'ready', message: 'ready' })
  expect(
    await running.call('languageServer.launch', {
      root: '/project with spaces',
      language: 'typescript',
    }),
  ).toEqual({
    project: [
      { path: 'node_modules/.bin/vp', args: ['fmt', '--lsp'] },
      { path: 'node_modules/.bin/oxfmt', args: ['--lsp'] },
    ],
  })
})
