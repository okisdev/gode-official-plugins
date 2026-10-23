import { defineLanguageServer, PluginError } from '@gode/plugin-sdk/plugin'
import { findJava } from './java.ts'
import { prepareMetals } from './metals.ts'

export default defineLanguageServer(async (paths) => {
  const java = findJava()
  if (!java) throw new PluginError({ message: 'missing' })
  return {
    kind: 'program',
    path: await prepareMetals(paths, java),
    args: [],
  }
})
