import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, startPlugin, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'
import { fixture } from './fixtures/repository.ts'

const run = promisify(execFile)

test('history records keep author, date, subject, and body', async () => {
  const { path } = await fixture()
  const session = await startPlugin(plugin)
  await writeFile(join(path, 'a.txt'), 'content\n')
  await session.call('sourceControl.workingCopy.commit', {
    path,
    message: 'subject\n\nmore details',
    options: { amend: false, excluded: [] },
  })
  const commits = await session.call('sourceControl.history.recent', { path, limit: 2 })
  expect(commits[0]).toMatchObject({
    author: 'Test Author',
    authorEmail: 'test@example.com',
    subject: 'subject',
    body: '\nmore details',
  })
  expect(commits[0]!.date).toBeGreaterThan(0)
  expect(commits).toHaveLength(1)
  const ahead = await session.call('sourceControl.history.ahead', { path })
  const unpushed = await session.call('sourceControl.history.unpushed', { path })
  const notIn = await session.call('sourceControl.history.commitsNotIn', {
    path,
    base: 'none()',
  })
  expect(ahead.map((commit) => commit.id)).toEqual([commits[0]!.id])
  expect(unpushed).toEqual([commits[0]!.id])
  expect(notIn.map((commit) => commit.id)).toEqual([commits[0]!.id])
  expect(
    await session.call('sourceControl.commitsBetween', { path, from: null, to: '@-' }),
  ).toEqual([commits[0]!.id])
  const root = await run('jj', ['log', '-G', '-r', 'root()', '-T', 'commit_id'], { cwd: path })
  expect(await session.call('sourceControl.isAncestor', { path, id: root.stdout.trim() })).toBe(
    true,
  )
  expect(await session.call('sourceControl.history.verifiedCommit', { path, id: 'root()' })).toBe(
    null,
  )
})
