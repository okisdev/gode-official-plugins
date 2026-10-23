import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import { prepareMetals } from '../src/metals.ts'

test('shares overlapping fetches and prepares an atomic launcher in plugin data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gode-scala-metals-'))
  try {
    const plugin = join(root, 'plugin')
    const data = join(root, 'data')
    await Promise.all([mkdir(join(plugin, 'bin'), { recursive: true }), mkdir(data)])
    const coursier = join(plugin, 'bin', 'coursier')
    await writeFile(
      coursier,
      '#!/bin/sh\nprintf "%s\\n" "$*" "$COURSIER_CACHE" "$COURSIER_REPOSITORIES" >> "$HOME/calls"\nprintf "%s\\n" "$COURSIER_CACHE/example.jar"\n',
    )
    await chmod(coursier, 0o755)
    const paths = { plugin, data }
    const [first, second] = await Promise.all([
      prepareMetals(paths, '/java'),
      prepareMetals(paths, '/java'),
    ])
    expect(first).toBe(join(data, 'metals'))
    expect(second).toBe(first)
    expect(await readFile(join(data, 'calls'), 'utf8')).toBe(
      `fetch --classpath --no-default --repository https://repo.maven.apache.org/maven2 org.scalameta:metals_2.13:1.6.9\n${join(data, 'coursier')}\nhttps://repo.maven.apache.org/maven2\n`,
    )
    expect(await readFile(first, 'utf8')).toContain(
      `-cp '${join(data, 'coursier/example.jar')}' scala.meta.metals.Main "$@"`,
    )
    expect((await readdir(data)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
