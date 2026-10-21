import { definePlugin } from '@gode/plugin-sdk/plugin'
import { createVoicePlugin } from './plugin'

export default definePlugin(({ setStatus, setView }) => {
  const plugin = createVoicePlugin(setStatus, setView)
  process.once('exit', () => plugin.kill())
  return { ...plugin, stop: () => plugin.dispose() }
})
