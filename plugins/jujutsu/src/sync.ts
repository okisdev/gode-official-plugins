import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { bookmarks, currentBookmark } from './branches.ts'
import { id } from './records.ts'
import { jj, type Log } from './process.ts'

export function createSync(path: string, log: Log) {
  async function active() {
    const [items, head, parent] = await Promise.all([
      bookmarks(path, log),
      id(path, '@', log),
      id(path, '@-', log),
    ])
    const bookmark = currentBookmark(items, [head, parent])
    if (!bookmark) throw new Error('No bookmark points to the working copy or its parent.')
    return {
      bookmark,
      remote: items.find((item) => item.name === bookmark.name && item.remote && item.tracked),
    }
  }
  return {
    async lastFetched() {
      try {
        const root = (await jj(path, ['root'], log)).trim()
        const store = join(root, '.jj/repo/store')
        const target = (await readFile(join(store, 'git_target'), 'utf8')).trim()
        return (await stat(join(resolve(store, target), 'FETCH_HEAD'))).mtimeMs
      } catch {
        return null
      }
    },
    async remoteBranches() {
      const refs = await bookmarks(path, log)
      const remote = refs.find((item) => item.remote)?.remote ?? 'origin'
      return {
        remote,
        branches: refs.filter((item) => item.remote === remote).map((item) => item.name),
      }
    },
    async addRemote(name: string, url: string) {
      await jj(path, ['git', 'remote', 'add', name, url], log)
    },
    async fetch() {
      await jj(path, ['git', 'fetch'], log)
    },
    async pull(_strategy: 'config' | 'merge' | 'rebase' | 'ff-only') {
      const { bookmark } = await active()
      await jj(path, ['git', 'fetch'], log)
      const remote = (await bookmarks(path, log)).find(
        (item) => item.name === bookmark.name && item.remote && item.tracked,
      )
      if (!remote) throw new Error('The current bookmark has no tracked remote bookmark.')
      await jj(path, ['rebase', '-b', '@', '-d', `${remote.name}@${remote.remote}`], log)
    },
    async push() {
      const { bookmark } = await active()
      await jj(path, ['git', 'push', '--bookmark', bookmark.name], log)
    },
    async publish(remote: string) {
      const { bookmark } = await active()
      await jj(path, ['git', 'push', '--remote', remote, '--bookmark', bookmark.name], log)
    },
  }
}
