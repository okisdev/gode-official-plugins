import { join } from 'node:path'
import type { LanguageServerLaunch } from '@gode/plugin-sdk'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export function astroLaunch(paths: { plugin: string }): LanguageServerLaunch {
  return {
    kind: 'script',
    path: join(
      paths.plugin,
      'server',
      'node_modules',
      '@astrojs',
      'language-server',
      'bin',
      'nodeServer.js',
    ),
    args: [],
    initializationOptions: {
      typescript: { tsdk: join(paths.plugin, 'server', 'node_modules', 'typescript', 'lib') },
    },
  }
}

defineLanguageServer(astroLaunch, { ready: 'ready', failed: 'failed' })
