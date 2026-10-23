import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths) => {
  const system = join(paths.data, 'system')
  return {
    kind: 'program',
    path: join(paths.plugin, 'server', 'kotlin-server-263.7084.0', 'bin', 'intellij-server'),
    args: ['--stdio', '--system-path', system],
    env: {
      IJ_JAVA_OPTIONS: [
        `-Duser.home=${JSON.stringify(paths.data)}`,
        `-Djava.io.tmpdir=${JSON.stringify(paths.data)}`,
        `-Didea.config.path=${JSON.stringify(join(paths.data, 'config'))}`,
        `-Didea.log.path=${JSON.stringify(join(paths.data, 'log'))}`,
      ].join(' '),
    },
    initializationOptions: { indexDir: system },
  }
})
