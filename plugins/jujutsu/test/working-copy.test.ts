import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, startPlugin, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'
import { fixture } from './fixtures/repository.ts'

test('changes and commit preserve excluded paths', async () => {
  const { path } = await fixture()
  const session = await startPlugin(plugin)
  await writeFile(join(path, 'included.txt'), 'one\ntwo\n')
  await writeFile(join(path, 'excluded.txt'), 'other\n')
  const changes = await session.call('sourceControl.workingCopy.changes', { path })
  expect(changes.map((change) => change.path).sort()).toEqual(['excluded.txt', 'included.txt'])
  expect(changes.every((change) => change.staged === null && change.unstaged === 'added')).toBe(
    true,
  )
  const summaries = await session.call('sourceControl.workingCopy.summaries', {
    path,
    changes,
    ignoringWhitespace: false,
  })
  expect(summaries.staged).toEqual([])
  expect(summaries.unstaged.find((item) => item.path === 'included.txt')?.additions).toBe(2)
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'first commit',
    options: { amend: false, excluded: ['excluded.txt'] },
  })
  expect(await session.call('sourceControl.workingCopy.lastCommitMessage', { path })).toBe(
    'first commit',
  )
  const remaining = await session.call('sourceControl.workingCopy.changes', { path })
  expect(remaining.map((item) => item.path)).toEqual(['excluded.txt'])
})

test('ignored paths must exist under the repository root', async () => {
  const { path } = await fixture()
  const session = await startPlugin(plugin)
  await writeFile(join(path, '.gitignore'), '*.log\n')
  await writeFile(join(path, 'ignored.log'), 'hidden\n')
  await writeFile(join(path, 'tracked.txt'), 'visible\n')
  expect(
    await session.call('sourceControl.ignoredPaths', {
      path,
      paths: ['ignored.log', 'missing.log', 'tracked.txt'],
    }),
  ).toEqual(['ignored.log'])
})
