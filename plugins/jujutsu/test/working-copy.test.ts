import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, startPlugin, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'
import { fixture } from './fixtures/repository.ts'

const run = promisify(execFile)

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

test('commit advances a bookmark on the parent', async () => {
  const { path } = await fixture()
  const session = await startPlugin(plugin)
  await writeFile(join(path, 'first.txt'), 'first\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'first',
    options: { amend: false, excluded: [] },
  })
  await run('jj', ['bookmark', 'create', 'main', '-r', '@-'], { cwd: path })
  await writeFile(join(path, 'second.txt'), 'second\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'second',
    options: { amend: false, excluded: [] },
  })
  const bookmark = await run('jj', ['log', '-G', '-r', 'main', '-T', 'commit_id'], { cwd: path })
  const parent = await run('jj', ['log', '-G', '-r', '@-', '-T', 'commit_id'], { cwd: path })
  expect(bookmark.stdout.trim()).toBe(parent.stdout.trim())
  expect((await session.call('sourceControl.workingCopy.branchStatus', { path })).branch).toBe(
    'main',
  )
})

test('commit advances a bookmark on the working copy', async () => {
  const { path } = await fixture()
  const session = await startPlugin(plugin)
  await run('jj', ['bookmark', 'create', 'main', '-r', '@'], { cwd: path })
  await writeFile(join(path, 'first.txt'), 'first\n')
  await writeFile(join(path, 'excluded.txt'), 'later\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'first',
    options: { amend: false, excluded: ['excluded.txt'] },
  })
  const bookmark = await run('jj', ['log', '-G', '-r', 'main', '-T', 'commit_id'], { cwd: path })
  const parent = await run('jj', ['log', '-G', '-r', '@-', '-T', 'commit_id'], { cwd: path })
  expect(bookmark.stdout.trim()).toBe(parent.stdout.trim())
  expect((await session.call('sourceControl.workingCopy.branchStatus', { path })).branch).toBe(
    'main',
  )
})

test('commit leaves unrelated bookmarks alone', async () => {
  const { path } = await fixture()
  const session = await startPlugin(plugin)
  await writeFile(join(path, 'first.txt'), 'first\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'first',
    options: { amend: false, excluded: [] },
  })
  await run('jj', ['bookmark', 'create', 'other', '-r', 'root()'], { cwd: path })
  await writeFile(join(path, 'second.txt'), 'second\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'second',
    options: { amend: false, excluded: [] },
  })
  const bookmark = await run('jj', ['log', '-G', '-r', 'other', '-T', 'commit_id'], { cwd: path })
  const root = await run('jj', ['log', '-G', '-r', 'root()', '-T', 'commit_id'], { cwd: path })
  expect(bookmark.stdout.trim()).toBe(root.stdout.trim())
  expect((await session.call('sourceControl.workingCopy.branchStatus', { path })).branch).toBe(null)
})

test('amend keeps the bookmark on the amended commit', async () => {
  const { path } = await fixture()
  const session = await startPlugin(plugin)
  await writeFile(join(path, 'first.txt'), 'first\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'first',
    options: { amend: false, excluded: [] },
  })
  await run('jj', ['bookmark', 'create', 'main', '-r', '@-'], { cwd: path })
  await writeFile(join(path, 'second.txt'), 'second\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'amended',
    options: { amend: true, excluded: [] },
  })
  const bookmark = await run('jj', ['log', '-G', '-r', 'main', '-T', 'commit_id'], { cwd: path })
  const parent = await run('jj', ['log', '-G', '-r', '@-', '-T', 'commit_id'], { cwd: path })
  expect(bookmark.stdout.trim()).toBe(parent.stdout.trim())
  expect((await session.call('sourceControl.workingCopy.branchStatus', { path })).branch).toBe(
    'main',
  )
})

test('amend moves a bookmark on the working copy to the amended commit', async () => {
  const { path } = await fixture()
  const session = await startPlugin(plugin)
  await writeFile(join(path, 'first.txt'), 'first\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'first',
    options: { amend: false, excluded: [] },
  })
  await run('jj', ['bookmark', 'create', 'main', '-r', '@'], { cwd: path })
  await writeFile(join(path, 'second.txt'), 'second\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'amended',
    options: { amend: true, excluded: [] },
  })
  const bookmark = await run('jj', ['log', '-G', '-r', 'main', '-T', 'commit_id'], { cwd: path })
  const parent = await run('jj', ['log', '-G', '-r', '@-', '-T', 'commit_id'], { cwd: path })
  expect(bookmark.stdout.trim()).toBe(parent.stdout.trim())
  expect((await session.call('sourceControl.workingCopy.branchStatus', { path })).branch).toBe(
    'main',
  )
})
