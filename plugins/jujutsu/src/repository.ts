import { realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Checkout, Repository, Remote } from '@gode/plugin-sdk'
import { bookmarks, currentBookmark } from './branches.ts'
import { id, ids } from './records.ts'
import { jj, optional, type Log } from './process.ts'

const workspaceTemplate = 'name ++ "\\x1f" ++ target.commit_id() ++ "\\x1f" ++ root ++ "\\x1e"'

export function createRepository(path: string, log: Log) {
  async function root(): Promise<string | null> {
    return (await optional(path, ['root'], log))?.trim() ?? null
  }
  async function checkouts(): Promise<Checkout[]> {
    const output = await jj(path, ['workspace', 'list', '-T', workspaceTemplate], log)
    const refs = await bookmarks(path, log)
    return output.split('\x1e').flatMap((record) => {
      if (!record.trim()) return []
      const [name, head, folder] = record.trimStart().split('\x1f')
      if (!folder) return []
      return [
        {
          id: name ?? '',
          path: folder,
          head: head ?? '',
          branch: currentBookmark(refs, [head ?? ''])?.name ?? null,
          isMain: name === 'default',
          isLocked: false,
          lockReason: null,
          isPrunable: false,
        },
      ]
    })
  }
  async function repository(): Promise<Repository | null> {
    const folder = await root()
    if (!folder) return null
    const [store, workspaces, refs, trunk] = await Promise.all([
      realpath(join(folder, '.jj', 'repo')),
      checkouts(),
      bookmarks(path, log),
      id(path, 'trunk()', log),
    ])
    const local = refs.filter((item) => !item.remote)
    return {
      provider: 'jujutsu',
      id: store,
      root: folder,
      checkouts: workspaces,
      branches: local.map((item) => item.name),
      defaultReference: local.find((item) => item.target === trunk)?.name ?? 'trunk()',
    }
  }
  async function files(): Promise<string[]> {
    return (await jj(path, ['file', 'list'], log)).trim().split('\n').filter(Boolean)
  }
  async function ignoredPaths(paths: string[]): Promise<string[]> {
    const known = new Set(await files())
    const folder = await root()
    if (!folder) return []
    const checks = await Promise.all(
      paths.map(async (item) => {
        const target = resolve(folder, item)
        if (known.has(item) || !target.startsWith(`${folder}${sep}`)) return false
        try {
          await stat(target)
          return true
        } catch {
          return false
        }
      }),
    )
    return paths.filter((_item, index) => checks[index])
  }
  async function remotes(): Promise<Remote[]> {
    return (await jj(path, ['git', 'remote', 'list'], log))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, fetchURL] = line.split(/\s+/, 2)
        return { name: name ?? '', fetchURL: fetchURL ?? '', pushURL: null }
      })
  }
  return {
    repository,
    root,
    files,
    ignoredPaths,
    trackedPaths: async (paths: string[]) => {
      const known = new Set(await files())
      return paths.filter((item) => known.has(item))
    },
    remotes,
    userName: async () => (await optional(path, ['config', 'get', 'user.name'], log))?.trim() ?? '',
    isAncestor: async (commit: string) =>
      (await ids(path, `(${JSON.stringify(commit)}) & ::@`, log)).length > 0,
    commitsBetween: async (from: string | null, to: string) =>
      ids(path, from ? `${from}..${to}` : `::${to}`, log),
    checkouts,
  }
}
