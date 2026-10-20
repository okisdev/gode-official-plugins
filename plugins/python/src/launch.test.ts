import { join } from 'node:path'
import type { HostMessage, PluginMessage } from '@gode/plugin-sdk'
import type { PluginPort } from '@gode/plugin-sdk/plugin'
import { expect, test } from 'vitest'

test('answers the host with a Node script launch under the installed plugin', async () => {
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
    const paths = { plugin: '/tmp/gode-installed-python', data: '/tmp/gode-python-data' }
    listener?.({ data: { type: 'start', settings: {}, secrets: {}, paths, locale: 'en' } })
    listener?.({
      data: {
        type: 'call',
        id: 1,
        method: 'languageServer.launch',
        params: { root: '/tmp/project', language: 'python' },
      },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(posted).toContainEqual({ type: 'status', status: { state: 'ready', message: 'ready' } })
    expect(posted).toContainEqual({
      type: 'reply',
      id: 1,
      result: {
        kind: 'script',
        path: join(paths.plugin, 'server', 'node_modules', 'basedpyright', 'langserver.index.js'),
        args: [],
      },
    })
  } finally {
    if (previous) host.parentPort = previous
    else delete host.parentPort
  }
})
