import { realpath, rm } from 'node:fs/promises'
import { createRepository } from './repository.ts'
import { id } from './records.ts'
import { jj, type Log } from './process.ts'

export function createCheckouts(path: string, log: Log) {
  const repository = createRepository(path, log)
  async function checkRemoval(checkoutPath: string): Promise<'changes' | null> {
    return (await jj(checkoutPath, ['diff', '--summary', '-r', '@'], log)).trim() ? 'changes' : null
  }
  return {
    async create(options: { path: string; branch: string; start: string; newBranch: boolean }) {
      const start = (await id(path, options.start, log)).startsWith('00000000')
        ? '@'
        : options.start
      if (options.newBranch)
        await jj(path, ['bookmark', 'create', options.branch, '-r', start], log)
      await jj(path, ['workspace', 'add', options.path, '-r', options.branch], log)
      const actual = await realpath(options.path)
      const created = (await repository.checkouts()).find((item) => item.path === actual)
      if (!created) throw new Error('The new workspace is missing from the repository.')
      return created
    },
    checkRemoval,
    async remove(checkoutPath: string, _force: boolean) {
      if (!_force && (await checkRemoval(checkoutPath)))
        throw new Error('The workspace has changes.')
      const actual = await realpath(checkoutPath)
      const checkout = (await repository.checkouts()).find((item) => item.path === actual)
      if (!checkout) throw new Error('Workspace not found.')
      await jj(path, ['workspace', 'forget', checkout.id], log)
      await rm(checkout.path, { recursive: true, force: true })
    },
  }
}
