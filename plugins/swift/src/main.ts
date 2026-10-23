import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { PluginError, defineLanguageServer, findProgram } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => {
  const available =
    process.platform === 'darwin'
      ? spawnSync('xcrun', ['--find', 'sourcekit-lsp'], { stdio: 'ignore' }).status === 0
      : !!findProgram('sourcekit-lsp')
  if (!available) throw new PluginError({ message: 'missing' })
  return {
    kind: 'program',
    path: join(paths.plugin, 'bin', 'sourcekit-lsp'),
    args: [],
  }
})
