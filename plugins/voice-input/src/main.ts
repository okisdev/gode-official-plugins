import { definePlugin } from '@gode/plugin-sdk/plugin'
import type { Names } from './names'
import { createVoicePlugin } from './plugin'

export default definePlugin<Names>((context) => {
  const plugin = createVoicePlugin(context)
  process.once('exit', () => plugin.kill())
  return { ...plugin, stop: () => plugin.dispose() }
})
