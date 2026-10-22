import type { Branch } from '@gode/plugin-sdk'
import { commits, id } from './records.ts'
import { jj, type Log } from './process.ts'

const template =
  'name ++ "\\x1f" ++ remote ++ "\\x1f" ++ normal_target.commit_id() ++ "\\x1f" ++ tracked ++ "\\x1f" ++ tracking_ahead_count.lower() ++ "\\x1f" ++ tracking_behind_count.lower() ++ "\\x1e"'

export interface Bookmark {
  name: string
  remote: string
  target: string
  tracked: boolean
  ahead: number
  behind: number
}

export async function bookmarks(path: string, log: Log): Promise<Bookmark[]> {
  const output = await jj(path, ['bookmark', 'list', '--all-remotes', '-T', template], log)
  return output.split('\x1e').flatMap((record) => {
    if (!record.trim()) return []
    const [name, remote, target, tracked, ahead, behind] = record.trimStart().split('\x1f')
    if (!target || remote === 'git') return []
    return [
      {
        name: name ?? '',
        remote: remote ?? '',
        target,
        tracked: tracked === 'true',
        ahead: Number(ahead) || 0,
        behind: Number(behind) || 0,
      },
    ]
  })
}

export function currentBookmark(items: Bookmark[], heads: string[]): Bookmark | undefined {
  return items.find((item) => !item.remote && heads.includes(item.target))
}

export async function branchTarget(path: string, name: string, log: Log): Promise<string> {
  const refs = await bookmarks(path, log)
  const local = refs.find((item) => !item.remote && item.name === name)
  const remote = refs.find((item) => item.remote && `${item.name}@${item.remote}` === name)
  if (!local && !remote) throw new Error(`Bookmark ${name} was not found.`)
  return (local ?? remote)!.target
}

export function createBranches(path: string, log: Log) {
  async function list(): Promise<Branch[]> {
    const [items, head, parent] = await Promise.all([
      bookmarks(path, log),
      id(path, '@', log),
      id(path, '@-', log),
    ])
    return Promise.all(
      items.map(async (item): Promise<Branch> => {
        const target = (await commits(path, item.target, log, 1))[0]
        const upstream = !item.remote
          ? items.find((other) => other.remote && other.name === item.name && other.tracked)
          : undefined
        return {
          name: item.remote ? `${item.name}@${item.remote}` : item.name,
          isRemote: !!item.remote,
          remote: item.remote || null,
          upstream: upstream ? `${upstream.remote}/${upstream.name}` : null,
          ahead: item.remote ? item.behind : (upstream?.behind ?? 0),
          behind: item.remote ? item.ahead : (upstream?.ahead ?? 0),
          isUpstreamGone: false,
          date: target?.date ?? null,
          subject: target?.subject ?? '',
          isHead: !item.remote && (item.target === head || item.target === parent),
          checkoutPath: null,
        }
      }),
    )
  }
  return {
    list,
    async switch(name: string) {
      await jj(path, ['new', name], log)
    },
    async create(name: string, start: string | null, switching: boolean) {
      const target = start || ((await id(path, '@-', log)).startsWith('00000000') ? '@' : '@-')
      await jj(path, ['bookmark', 'create', name, '-r', target], log)
      if (switching) await jj(path, ['new', name], log)
    },
    async rename(name: string, newName: string) {
      await jj(path, ['bookmark', 'rename', name, newName], log)
    },
    async delete(name: string, _force: boolean) {
      await jj(path, ['bookmark', 'delete', name], log)
    },
    async deleteRemote(name: string, remote: string) {
      const refs = await bookmarks(path, log)
      const local = refs.find((item) => !item.remote && item.name === name)
      if (!local) await jj(path, ['bookmark', 'track', `${name}@${remote}`], log)
      await jj(path, ['bookmark', 'delete', name], log)
      try {
        await jj(path, ['git', 'push', '--remote', remote, '--bookmark', name], log)
      } finally {
        if (local) await jj(path, ['bookmark', 'set', name, '-r', local.target], log)
      }
    },
    async compare(branch: string) {
      const target = await branchTarget(path, branch, log)
      const ours = `::@- ~ ::${target}`
      const theirs = `::${target} ~ ::@-`
      const [ahead, behind] = await Promise.all([
        commits(path, ours, log),
        commits(path, theirs, log),
      ])
      return { ahead, behind }
    },
    async invalidName(name: string, existing: string[]): Promise<'invalid' | 'nested' | null> {
      if (
        !name ||
        /[\s~^:?*\\]/.test(name) ||
        name.includes('[') ||
        name.includes('..') ||
        name.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock')) ||
        name.startsWith('-')
      )
        return 'invalid'
      if (existing.some((item) => item.startsWith(`${name}/`) || name.startsWith(`${item}/`)))
        return 'nested'
      return null
    },
  }
}
