import { branchTarget } from './branches.ts'
import { commits, id, ids } from './records.ts'
import { jj, optional, type Log } from './process.ts'

export function createHistory(path: string, log: Log) {
  const unpushed = () => ids(path, '::@- ~ ::remote_bookmarks()', log)
  const ahead = () => commits(path, '::@- ~ ::remote_bookmarks()', log)
  return {
    recent: (limit: number) => commits(path, '::@-', log, limit),
    ahead,
    unpushed,
    commitsNotIn: (base: string) => commits(path, `::@- ~ ::${base}`, log),
    commitDiff: (commit: string, ignoringWhitespace: boolean) =>
      jj(path, ['diff', '--git', '-r', commit, ...(ignoringWhitespace ? ['-w'] : [])], log),
    async comparisonRange(branch: string, side: 'ahead' | 'behind') {
      const current = await id(path, '@-', log)
      const other = await branchTarget(path, branch, log)
      const base = side === 'ahead' ? other : current
      const to = side === 'ahead' ? current : other
      const count = (await ids(path, `${base}..${to}`, log)).length
      return { from: base, to, commits: count }
    },
    rangeDiff: (base: string, tip: string, ignoringWhitespace: boolean) =>
      jj(
        path,
        ['diff', '--git', '-f', base, '-t', tip, ...(ignoringWhitespace ? ['-w'] : [])],
        log,
      ),
    async verifiedCommit(commit: string) {
      return (await optional(path, ['log', '-G', '-r', commit, '-T', 'commit_id'], log))
        ? ((await commits(path, commit, log, 1))[0] ?? null)
        : null
    },
  }
}
