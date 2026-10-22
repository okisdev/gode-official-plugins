import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { onTestFinished } from '@gode/plugin-sdk/test'

const run = promisify(execFile)

export async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'gode-jj-'))
  const config = join(temp, 'config.toml')
  const path = join(temp, 'repo')
  await writeFile(config, '[user]\nname = "Test Author"\nemail = "test@example.com"\n')
  const previous = process.env.JJ_CONFIG
  process.env.JJ_CONFIG = config
  await run('jj', ['git', 'init', path], { env: { ...process.env, JJ_CONFIG: config } })
  onTestFinished(async () => {
    if (previous === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = previous
    await rm(temp, { recursive: true, force: true })
  })
  return { path, temp }
}
