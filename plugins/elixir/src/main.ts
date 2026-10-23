import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => ({
  kind: 'program',
  path: join(paths.plugin, 'bin', 'expert'),
  args: ['--stdio'],
  env: { EXPERT_INSTALL_DIR: join(paths.data, 'expert-v0.2.1') },
}))
