import { join } from 'node:path'
import { PluginError, defineLanguageServer, findProgram } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => {
  if (!findProgram('nixd')) throw new PluginError({ message: 'missing' })
  return {
    kind: 'program',
    path: join(paths.plugin, 'bin', 'nixd'),
    args: [],
  }
})
