import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@gode/plugin-sdk/test'
import { installLanguageserver, languageServerVersion } from '../src/install.ts'

const run = promisify(execFile)

test('installs once into an isolated versioned R library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gode-r-test-'))
  try {
    const rscript = join(root, 'Rscript')
    const r = join(root, 'R')
    await writeFile(
      rscript,
      `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const library = process.argv.at(-2);
if (process.env.R_LIBS !== library) process.exit(1);
fs.mkdirSync(path.join(library, 'languageserver'));
fs.writeFileSync(path.join(library, 'languageserver', 'DESCRIPTION'), 'Version: ${languageServerVersion}\\n');
fs.appendFileSync(path.join(path.dirname(library), 'calls'), 'install\\n');
`,
      { mode: 0o755 },
    )
    await writeFile(r, '#!/bin/sh\nprintf "%s|%s|%s|%s|%s" "$1" "$2" "$3" "$4" "$R_LIBS"\n', {
      mode: 0o755,
    })
    const data = join(root, 'data')
    const download = async (path: string) => writeFile(path, 'archive')
    const [first, second] = await Promise.all([
      installLanguageserver(data, rscript, r, download),
      installLanguageserver(data, rscript, r, download),
    ])
    expect(first.path).toBe(second.path)
    expect(first.path).toBe(join(data, 'languageserver', languageServerVersion, 'language-server'))
    expect(first.env.R_LIBS).toBe(join(data, 'languageserver', languageServerVersion, 'library'))
    const launched = await run(first.path, [], { env: { ...process.env, ...first.env } })
    expect(launched.stdout).toBe(`--slave|--vanilla|-e|languageserver::run()|${first.env.R_LIBS}`)
    expect(
      (await readFile(join(data, 'languageserver', languageServerVersion, 'calls'), 'utf8')).trim(),
    ).toBe('install')
    await installLanguageserver(data, rscript, r, download)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
