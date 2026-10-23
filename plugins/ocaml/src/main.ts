import { join } from 'node:path'
import { PluginError, defineLanguageServer, findProgram } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => {
  if (!findProgram('ocamllsp')) throw new PluginError({ message: 'missing' })
  return {
    kind: 'program',
    path: join(paths.plugin, 'bin', 'ocamllsp'),
    args: [],
  }
})
