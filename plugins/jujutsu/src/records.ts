import type { Commit } from '@gode/plugin-sdk'
import { jj, type Log } from './process.ts'

const separator = '\x1f'
const end = '\x1e'
const commitTemplate = `commit_id ++ "\\x1f" ++ commit_id.short(12) ++ "\\x1f" ++ author.name() ++ "\\x1f" ++ author.email() ++ "\\x1f" ++ author.timestamp().format("%Y-%m-%dT%H:%M:%S%:z") ++ "\\x1f" ++ description ++ "\\x1e"`

export async function commits(
  path: string,
  revset: string,
  log: Log,
  limit?: number,
): Promise<Commit[]> {
  const args = ['log', '-G', '-r', `(${revset}) ~ root()`, '-T', commitTemplate]
  if (limit !== undefined) args.push('-n', String(limit))
  const output = await jj(path, args, log)
  return output.split(end).flatMap((record) => {
    if (!record.trim()) return []
    const [id, shortID, author, authorEmail, iso, description = ''] = record
      .trimStart()
      .split(separator)
    const [subject, ...body] = description.replace(/\n$/, '').split('\n')
    return [
      {
        id: id ?? '',
        shortID: shortID ?? '',
        author: author ?? '',
        authorEmail: authorEmail ?? '',
        date: Date.parse(iso ?? ''),
        subject: subject ?? '',
        body: body.join('\n'),
      },
    ]
  })
}

export async function ids(path: string, revset: string, log: Log): Promise<string[]> {
  return (
    await jj(path, ['log', '-G', '-r', `(${revset}) ~ root()`, '-T', 'commit_id ++ "\\n"'], log)
  )
    .trim()
    .split('\n')
    .filter(Boolean)
}

export async function id(path: string, revset: string, log: Log): Promise<string> {
  return (await jj(path, ['log', '-G', '-r', revset, '-T', 'commit_id'], log)).trim()
}
