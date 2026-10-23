import { join } from 'node:path'

const prefix = 'gode/updates/plugins'

function upload(file, source, contentType, cacheControl) {
  return {
    file,
    args: [
      'exec',
      'wrangler',
      'r2',
      'object',
      'put',
      `${prefix}/${file}`,
      '--file',
      source,
      '--remote',
      '--cache-control',
      cacheControl,
      '--content-type',
      contentType,
    ],
  }
}

export function releasePlan(id, directory, archives) {
  if (!archives.length) throw new Error('No plugin builds to publish')
  const base = `gode/${id}`
  return [
    ...archives.map((file) =>
      upload(
        `${base}/${file}`,
        join(directory, file),
        'application/octet-stream',
        'public, max-age=31536000, immutable',
      ),
    ),
    upload(
      `${base}/releases.json`,
      join(directory, 'releases.json'),
      'application/json',
      'no-cache',
    ),
  ]
}

export function catalogPlan(path) {
  return upload('index.json', path, 'application/json', 'no-cache')
}

export function archiveMatches(local, remote) {
  return local.equals(remote)
}
