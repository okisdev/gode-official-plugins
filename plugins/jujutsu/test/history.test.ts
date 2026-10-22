import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, startPlugin, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'
import { fixture } from './fixtures/repository.ts'

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
})
