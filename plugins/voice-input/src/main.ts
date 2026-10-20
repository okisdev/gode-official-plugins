import { definePlugin } from '@gode/plugin-sdk/plugin'
import { createVoicePlugin } from './plugin'

let plugin: ReturnType<typeof createVoicePlugin>
const disconnect = definePlugin((setStatus, setView) => {
  plugin = createVoicePlugin(setStatus, setView)
  return plugin
})
process.once('exit', () => plugin.kill())
process.once('SIGTERM', () => {
  disconnect()
  void plugin.dispose().finally(() => process.exit(0))
})
