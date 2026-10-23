import { appendFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ChangesDiffFile,
  ChangesDiffTextSource,
  ChangesFileSummary,
  WorkingCopyChange,
} from '@gode/plugin-sdk'
import { bookmarks, currentBookmark } from './branches.ts'
import { createRepository } from './repository.ts'
import { id, ids } from './records.ts'
import { jj, jjBytes, type Log } from './process.ts'

function pathsFromSummary(output: string): WorkingCopyChange[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const kind = line[0]
      const paths = line.slice(2).split(' => ')
      return {
        path: paths.at(-1)!,
        previousPath: paths.length > 1 ? paths[0]! : null,
        staged: null,
        unstaged:
          ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' } as const)[
            kind as 'A' | 'M' | 'D' | 'R' | 'C'
          ] ?? 'modified',
        isSubmodule: false,
      }
    })
}

function summary(diff: string, change: WorkingCopyChange): ChangesFileSummary {
  let additions = 0,
    deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return {
    path: change.path,
    status:
      change.unstaged === 'conflicted'
        ? 'modified'
        : (change.unstaged as ChangesFileSummary['status']),
    additions,
    deletions,
    isBinary: /GIT binary patch|Binary files/.test(diff),
  }
}

function revisions(source: ChangesDiffTextSource): [string, string] | null {
  switch (source.kind) {
    case 'unstaged':
      return ['@-', '@']
    case 'commit':
      return [`${source.sha}-`, source.sha]
    case 'range':
      return [source.from, source.to]
    default:
      return null
  }
}

export function createWorkingCopy(path: string, log: Log) {
  async function changes(): Promise<WorkingCopyChange[]> {
    const [output, hasConflicts] = await Promise.all([
      jj(path, ['diff', '--summary', '-r', '@'], log),
      jj(path, ['log', '-G', '-r', '@', '-T', 'conflict'], log),
    ])
    const conflicts = hasConflicts === 'true' ? await jj(path, ['resolve', '--list'], log) : ''
    const result = pathsFromSummary(output)
    const conflicted = new Set(
      (conflicts ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.trim().replace(/^C\s+/, '')),
    )
    return result.map((change) =>
      conflicted.has(change.path) ? { ...change, unstaged: 'conflicted' } : change,
    )
  }
  async function fileContent(revision: string, file: string): Promise<Buffer | null> {
    try {
      return await jjBytes(path, ['file', 'show', '-r', revision, '--', file], log)
    } catch {
      return null
    }
  }
  async function branchStatus() {
    const [head, parent, items, dirty] = await Promise.all([
      id(path, '@', log),
      id(path, '@-', log),
      bookmarks(path, log),
      jj(path, ['diff', '--summary', '-r', '@'], log),
    ])
    const bookmark = currentBookmark(items, [head, parent])
    const remote = items.find((item) => item.remote && item.name === bookmark?.name && item.tracked)
    const upstream = remote
      ? `remote_bookmarks(exact:${JSON.stringify(remote.name)}, remote=exact:${JSON.stringify(remote.remote)})`
      : null
    const [ahead, behind] = upstream
      ? await Promise.all([
          ids(path, `::@- ~ ::(${upstream})`, log),
          ids(path, `::(${upstream}) ~ ::@-`, log),
        ])
      : [[], []]
    return {
      head,
      branch: bookmark?.name ?? null,
      upstream: remote ? `${remote.remote}/${remote.name}` : null,
      ahead: ahead.length,
      behind: behind.length,
      isDirty: !!dirty.trim(),
      isUpstreamGone: false,
    }
  }
  return {
    changes,
    async summaries(changed: WorkingCopyChange[], ignoringWhitespace: boolean) {
      const unstaged = await Promise.all(
        changed.map(async (change) =>
          summary(
            await jj(
              path,
              [
                'diff',
                '--git',
                '-r',
                '@',
                ...(ignoringWhitespace ? ['-w'] : []),
                '--',
                change.path,
              ],
              log,
            ),
            change,
          ),
        ),
      )
      return { unstaged, staged: [] as ChangesFileSummary[] }
    },
    async fileDiff(
      side: 'staged' | 'unstaged',
      file: string,
      _previousPath: string | null,
      _untracked: boolean,
      ignoringWhitespace: boolean,
    ) {
      return side === 'staged'
        ? ''
        : jj(
            path,
            ['diff', '--git', '-r', '@', ...(ignoringWhitespace ? ['-w'] : []), '--', file],
            log,
          )
    },
    async diffFileText(source: ChangesDiffTextSource, file: ChangesDiffFile) {
      const pair = revisions(source)
      if (!pair) return null
      const content = await fileContent(pair[1], file.newPath ?? file.oldPath ?? '')
      if (!content || content.includes(0)) return null
      const text = content.toString('utf8')
      return { text, lineCount: text ? text.split('\n').length - Number(text.endsWith('\n')) : 0 }
    },
    async diffFilePictures(source: ChangesDiffTextSource, file: ChangesDiffFile) {
      const pair = revisions(source)
      if (!pair) return null
      const [before, after] = await Promise.all([
        file.oldPath ? fileContent(pair[0], file.oldPath) : null,
        file.newPath ? fileContent(pair[1], file.newPath) : null,
      ])
      const picture = (data: Buffer | null, name: string | null) => {
        if (!data || !name) return null
        const ext = name.toLowerCase().split('.').at(-1)
        const mime = (
          {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
            svg: 'image/svg+xml',
          } as Record<string, string>
        )[ext ?? '']
        return mime ? `data:${mime};base64,${data.toString('base64')}` : null
      }
      const left = picture(before, file.oldPath),
        right = picture(after, file.newPath)
      return left || right ? { before: left, after: right } : null
    },
    branchStatus,
    async discard(tracked: string[]) {
      if (tracked.length) await jj(path, ['restore', '--', ...tracked], log)
    },
    async commit(message: string, options: { amend: boolean; excluded: string[] }) {
      const included = (await changes())
        .map((change) => change.path)
        .filter((file) => !options.excluded.includes(file))
      if (!included.length && options.excluded.length) return
      if (options.amend) {
        await jj(
          path,
          ['squash', '-m', message, ...(options.excluded.length ? ['--', ...included] : [])],
          log,
        )
        return
      }
      const [items, head, parent] = await Promise.all([
        bookmarks(path, log),
        id(path, '@', log),
        id(path, '@-', log),
      ])
      const advancing = items.filter(
        (item) => !item.remote && (item.target === head || item.target === parent),
      )
      await jj(
        path,
        ['commit', '-m', message, ...(options.excluded.length ? ['--', ...included] : [])],
        log,
      )
      for (const bookmark of advancing)
        await jj(path, ['bookmark', 'set', bookmark.name, '-r', '@-'], log)
    },
    async lastCommitMessage() {
      return (await jj(path, ['log', '-G', '-r', '@-', '-T', 'description'], log)).trim()
    },
    async ignore(patterns: string[]) {
      const root = (await jj(path, ['root'], log)).trim()
      await appendFile(join(root, '.gitignore'), `\n${patterns.join('\n')}\n`)
    },
    ignored: (paths: string[]) => createRepository(path, log).ignoredPaths(paths),
    async oversizedFiles(paths: string[], limit: number) {
      const sizes = await Promise.all(
        paths.map(async (file) => {
          try {
            return { path: file, size: (await stat(join(path, file))).size }
          } catch {
            return null
          }
        }),
      )
      return sizes.filter(
        (file): file is { path: string; size: number } => !!file && file.size > limit,
      )
    },
    async watchTargets() {
      const root = (await jj(path, ['root'], log)).trim()
      return {
        directories: [],
        metadata: ['.jj', '.git'],
        statePaths: [join(root, '.jj/repo/op_heads'), join(root, '.jj/working_copy')],
      }
    },
  }
}
