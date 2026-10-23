import { defineLanguageServer } from '@gode/plugin-sdk/plugin'
import { installGopls } from './install.ts'

export default defineLanguageServer(async (paths) => ({
  kind: 'program',
  path: await installGopls(paths.data),
  args: [],
}))
