import { expect, startPlugin, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'
import { fixture } from './fixtures/repository.ts'

test('bookmark creation and switching', async () => {
  const { path } = await fixture()
  const session = await startPlugin(plugin)
  await session.call('sourceControl.branches.create', {
    path,
    name: 'topic',
    start: null,
    switching: false,
  })
  expect(
    (await session.call('sourceControl.branches.list', { path })).some(
      (item) => item.name === 'topic' && item.remote === null,
    ),
  ).toBe(true)
  await session.call('sourceControl.branches.switch', { path, name: 'topic' })
  expect((await session.call('sourceControl.workingCopy.branchStatus', { path })).branch).toBe(
    'topic',
  )
})
