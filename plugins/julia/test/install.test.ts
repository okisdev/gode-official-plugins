import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@gode/plugin-sdk/test'
import { installLanguageServer, languageServerVersion } from '../src/install.ts'

const run = promisify(execFile)

test('installs once into an isolated versioned Julia depot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gode-julia-test-'))
  try {
    const julia = join(root, 'julia')
    await writeFile(
      julia,
      `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
if (process.argv.includes('using LanguageServer; runserver()')) {
  process.stdout.write(process.env.JULIA_DEPOT_PATH); process.exit(0);
}
const environment = process.argv.find((arg) => arg.startsWith('--project=')).slice(10);
if (!process.env.JULIA_DEPOT_PATH.startsWith(path.dirname(environment))) process.exit(1);
fs.appendFileSync(path.join(path.dirname(environment), 'calls'), 'install\\n');
fs.writeFileSync(path.join(environment, 'Manifest.toml'), 'installed');
`,
      { mode: 0o755 },
    )
    const data = join(root, 'data')
    const [first, second] = await Promise.all([
      installLanguageServer(data, julia),
      installLanguageServer(data, julia),
    ])
    expect(first.path).toBe(second.path)
    expect(first.path).toBe(
      join(data, 'LanguageServer.jl', languageServerVersion, 'language-server'),
    )
    expect(first.env.JULIA_DEPOT_PATH).toBe(
      join(data, 'LanguageServer.jl', languageServerVersion, 'depot'),
    )
    const launched = await run(first.path, [], { env: { ...process.env, ...first.env } })
    expect(launched.stdout).toBe(first.env.JULIA_DEPOT_PATH)
    expect(
      (
        await readFile(join(data, 'LanguageServer.jl', languageServerVersion, 'calls'), 'utf8')
      ).trim(),
    ).toBe('install')
    await installLanguageServer(data, julia)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
