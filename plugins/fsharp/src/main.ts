import { join } from 'node:path'
import { defineLanguageServer, findProgram, PluginError } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => {
  if (!findProgram('dotnet')) throw new PluginError({ message: 'missing' })
  return {
    kind: 'program',
    path: join(paths.plugin, 'bin', 'fsautocomplete'),
    args: [],
  }
})
