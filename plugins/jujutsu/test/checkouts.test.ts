import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { expect, startPlugin, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'
import { fixture } from './fixtures/repository.ts'

test('workspace add and forget', async () => {
  const { path, temp } = await fixture()
  const session = await startPlugin(plugin)
  const folder = join(temp, 'second')
  const checkout = await session.call('sourceControl.checkouts.create', {
    path,
    options: { path: folder, branch: 'topic', start: '@-', newBranch: true },
  })
  expect(checkout.path).toBe(realpathSync(folder))
  expect(
    await session.call('sourceControl.checkouts.checkRemoval', { path, checkoutPath: folder }),
  ).toBeNull()
  await session.call('sourceControl.checkouts.remove', { path, checkoutPath: folder, force: false })
  expect(existsSync(folder)).toBe(false)
})
