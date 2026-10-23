import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { defineLanguageServer, findProgram, PluginError } from '@gode/plugin-sdk/plugin'

export default defineLanguageServer((paths, request) => {
  if (!findProgram('pwsh')) throw new PluginError({ message: 'missing' })
  const workspace = createHash('sha256').update(request.root).digest('hex').slice(0, 16)
  return {
    kind: 'program',
    path: join(paths.plugin, 'bin', 'powershell-editor-services'),
    args: [
      '-HostName',
      'Gode',
      '-HostProfileId',
      'Gode',
      '-HostVersion',
      '0.1.19',
      '-BundledModulesPath',
      join(paths.plugin, 'server'),
      '-LogPath',
      join(paths.data, 'logs', workspace),
      '-LogLevel',
      'Normal',
      '-SessionDetailsPath',
      join(paths.data, `session-${workspace}.json`),
      '-Stdio',
      '-LanguageServiceOnly',
    ],
  }
})
