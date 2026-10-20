export function selectedPlatforms(requested, supported) {
  const platforms = requested.length ? [...new Set(requested)] : [...supported]
  for (const platform of platforms)
    if (!supported.includes(platform)) throw new Error(`Unsupported plugin platform: ${platform}`)
  return platforms
}

export function verifySHA256(actual, expected, file) {
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${file}`)
}

export function runtimeFiles(entries) {
  const files = entries.filter(
    (entry) =>
      entry === 'package/LICENSE' ||
      entry === 'package/NOTICE.txt' ||
      entry === 'package/lib/tsc' ||
      /^package\/lib\/lib(?:\.[a-z0-9.]+)?\.d\.ts$/.test(entry),
  )
  for (const required of [
    'package/LICENSE',
    'package/NOTICE.txt',
    'package/lib/tsc',
    'package/lib/lib.d.ts',
    'package/lib/lib.es5.d.ts',
    'package/lib/lib.dom.d.ts',
    'package/lib/lib.esnext.d.ts',
  ])
    if (!files.includes(required)) throw new Error(`Runtime archive lacks ${required}`)
  return files.sort()
}
