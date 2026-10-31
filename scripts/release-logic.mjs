import { join } from 'node:path'

const prefix = 'gode/updates/plugins'

function compareAppVersions(left, right) {
  const [leftCore, leftBeta] = left.split('-beta.')
  const [rightCore, rightBeta] = right.split('-beta.')
  const leftParts = leftCore.split('.').map(BigInt)
  const rightParts = rightCore.split('.').map(BigInt)
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1
  }
  if (leftBeta === undefined) return rightBeta === undefined ? 0 : 1
  if (rightBeta === undefined) return -1
  const leftNumber = BigInt(leftBeta)
  const rightNumber = BigInt(rightBeta)
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
}

export function retainedReleases(releases) {
  const newest = releases.slice(0, 3)
  const oldestMinimum = newest.reduce(
    (minimum, release) =>
      compareAppVersions(release.manifest.minimumAppVersion, minimum) < 0
        ? release.manifest.minimumAppVersion
        : minimum,
    newest[0]?.manifest.minimumAppVersion,
  )
  const seen = new Set()
  return [
    ...newest,
    ...releases.slice(3).filter((release) => {
      const minimum = release.manifest.minimumAppVersion
      if (compareAppVersions(minimum, oldestMinimum) >= 0 || seen.has(minimum)) return false
      seen.add(minimum)
      return true
    }),
  ]
}

export function deletePlan(id, previous, retained) {
  const keptUrls = new Set(
    retained.flatMap((release) => Object.values(release.builds).map((build) => build.url)),
  )
  const files = new Set()
  for (const release of previous) {
    for (const [platform, build] of Object.entries(release.builds)) {
      const file = `${id}-${release.manifest.version}-${platform}.tar.br`
      if (build.url === file && !keptUrls.has(file)) files.add(file)
    }
  }
  return [...files].map((file) => ({
    file: `gode/${id}/${file}`,
    args: [
      'exec',
      'wrangler',
      'r2',
      'object',
      'delete',
      `${prefix}/gode/${id}/${file}`,
      '--remote',
    ],
  }))
}

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
