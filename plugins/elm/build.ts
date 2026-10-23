import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lockedNpmServer } from '@gode/plugin-sdk/build'

const stageServer = lockedNpmServer({
  bundle: '@elm-tooling/elm-language-server/out/node/index.js',
  keep: ['web-tree-sitter'],
})

export default async function build(stage: Parameters<typeof stageServer>[0]): Promise<void> {
  await stageServer(stage)
  const path = join(
    stage.directory,
    'server',
    'node_modules',
    '@elm-tooling',
    'elm-language-server',
    'package.json',
  )
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { type: string }
  manifest.type = 'commonjs'
  await writeFile(path, JSON.stringify(manifest))
}
