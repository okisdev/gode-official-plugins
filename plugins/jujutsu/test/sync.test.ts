import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, startPlugin, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'
import { fixture } from './fixtures/repository.ts'

const run = promisify(execFile)

test('publish and remote deletion keep the local bookmark', async () => {
  const { path, temp } = await fixture()
  const remote = join(temp, 'remote.git')
  await run('git', ['init', '--bare', remote])
  const session = await startPlugin(plugin)
  await writeFile(join(path, 'a.txt'), 'content\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'first',
    options: { amend: false, excluded: [] },
  })
  await session.call('sourceControl.branches.create', {
    path,
    name: 'topic',
    start: null,
    switching: false,
  })
  await session.call('sourceControl.sync.addRemote', { path, name: 'origin', url: remote })
  await session.call('sourceControl.sync.publish', { path, remote: 'origin' })
  const branches = await session.call('sourceControl.branches.list', { path })
  expect(
    branches.some((item) => item.name === 'topic' && !item.isRemote && item.remote === null),
  ).toBe(true)
  expect(
    branches.some(
      (item) => item.name === 'topic@origin' && item.isRemote && item.remote === 'origin',
    ),
  ).toBe(true)
  await session.call('sourceControl.history.commitsNotIn', { path, base: 'topic@origin' })
  expect((await session.call('sourceControl.sync.remoteBranches', { path })).branches).toContain(
    'topic',
  )
  expect((await session.call('sourceControl.workingCopy.branchStatus', { path })).upstream).toBe(
    'origin/topic',
  )
  await session.call('sourceControl.branches.deleteRemote', {
    path,
    name: 'topic',
    remote: 'origin',
  })
  expect(
    (await session.call('sourceControl.branches.list', { path })).some(
      (item) => item.name === 'topic' && !item.isRemote,
    ),
  ).toBe(true)
  const { stdout } = await run('git', ['ls-remote', remote])
  expect(stdout.trim()).toBe('')
}, 10_000)
