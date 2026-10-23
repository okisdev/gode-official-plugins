import { defineLanguageServer } from '@gode/plugin-sdk/plugin'
import { installLanguageServer } from './install.ts'

export default defineLanguageServer(async (paths) => ({
  kind: 'program',
  args: [],
  ...(await installLanguageServer(paths.data)),
}))
