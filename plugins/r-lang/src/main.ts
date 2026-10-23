import { defineLanguageServer } from '@gode/plugin-sdk/plugin'
import { installLanguageserver } from './install.ts'

export default defineLanguageServer(async (paths) => ({
  kind: 'program',
  args: [],
  ...(await installLanguageserver(paths.data)),
}))
