import { join } from 'node:path'
import type { HostMessage, PluginMessage } from '@gode/plugin-sdk'
import type { PluginPort } from '@gode/plugin-sdk/plugin'
import { expect, test } from 'vitest'

test('answers the host with a plain LSP script launch and its local TypeScript SDK', async () => {
  let listener: ((event: { data: HostMessage }) => void) | undefined
  const posted: PluginMessage[] = []
  const port: PluginPort = {
    on(_event, callback) {
      listener = callback
    },
    off() {
      listener = undefined
    },
    postMessage(message) {
      posted.push(message)
    },
  }
  const host = process as NodeJS.Process & { parentPort?: PluginPort }
  const previous = host.parentPort
  host.parentPort = port
  try {
    await import('./main')
    const paths = { plugin: '/tmp/gode-installed-vue', data: '/tmp/gode-vue-data' }
    listener?.({ data: { type: 'start', settings: {}, secrets: {}, paths, locale: 'en' } })
    listener?.({
      data: {
        type: 'call',
        id: 1,
        method: 'languageServer.launch',
        params: { root: '/tmp/project', language: 'vue' },
      },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(posted).toContainEqual({ type: 'status', status: { state: 'ready', message: 'ready' } })
    expect(posted).toContainEqual({
      type: 'reply',
      id: 1,
      result: {
        kind: 'script',
        path: join(
          paths.plugin,
          'server',
          'node_modules',
          '@vue',
          'language-server',
          'bin',
          'vue-language-server.js',
        ),
        args: [],
        initializationOptions: {
          typescript: { tsdk: join(paths.plugin, 'server', 'node_modules', 'typescript', 'lib') },
          vue: { hybridMode: false },
        },
      },
    })
  } finally {
    if (previous) host.parentPort = previous
    else delete host.parentPort
  }
})
