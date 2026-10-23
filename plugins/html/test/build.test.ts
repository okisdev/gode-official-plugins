import { expect, test } from '@gode/plugin-sdk/test'
import manifest from '../plugin.json' with { type: 'json' }
import server from '../server/package.json' with { type: 'json' }
import lock from '../server/package-lock.json' with { type: 'json' }

const version = '4.10.0'

test('pins vscode-langservers-extracted for the HTML language server', () => {
  expect(server.dependencies['vscode-langservers-extracted']).toBe(version)
  expect(lock.packages['node_modules/vscode-langservers-extracted'].version).toBe(version)
  expect(
    manifest.includes.find((entry) => entry.name === 'vscode-html-language-server')?.version,
  ).toBe(version)
})
