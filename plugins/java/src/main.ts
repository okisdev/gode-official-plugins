import { createHash } from 'node:crypto'
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PluginError, defineLanguageServer, findProgram } from '@gode/plugin-sdk/plugin'
import resources from '../resources.json' with { type: 'json' }

const configurations = {
  'darwin-arm64': 'config_mac_arm',
  'darwin-x64': 'config_mac',
  'linux-arm64': 'config_linux_arm',
  'linux-x64': 'config_linux',
} as const

export default defineLanguageServer(async (paths, request) => {
  const java =
    (process.env.JAVA_HOME && findProgram('java', join(process.env.JAVA_HOME, 'bin'))) ||
    findProgram('java')
  if (!java) throw new PluginError({ message: 'missing' })
  const server = join(paths.plugin, 'server')
  const platform = `${process.platform}-${process.arch}` as keyof typeof configurations
  const configuration = configurations[platform]
  if (!configuration) throw new PluginError({ message: 'failed' })
  const workspace = join(
    paths.data,
    'workspaces',
    createHash('sha256').update(request.root).digest('hex'),
  )
  await mkdir(workspace, { recursive: true })
  const configurationPath = join(workspace, 'configuration', configuration)
  await cp(join(server, configuration), configurationPath, { recursive: true })
  return {
    kind: 'program',
    path: join(paths.plugin, 'bin', 'jdtls'),
    args: [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1',
      '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product',
      '-Dlog.level=ERROR',
      '-Xmx1G',
      '--add-modules=ALL-SYSTEM',
      '--add-opens=java.base/java.util=ALL-UNNAMED',
      '--add-opens=java.base/java.lang=ALL-UNNAMED',
      '-jar',
      join(server, 'plugins', resources.launcher),
      '-configuration',
      configurationPath,
      '-data',
      workspace,
    ],
    env: { GODE_JAVA: java },
  }
})
