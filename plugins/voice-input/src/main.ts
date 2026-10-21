import { definePlugin } from '@gode/plugin-sdk/plugin'
import { createVoicePlugin } from './plugin'

export default definePlugin((context) => {
  const plugin = createVoicePlugin(context)
  process.once('exit', () => plugin.kill())
  return { ...plugin, stop: () => plugin.dispose() }
})
