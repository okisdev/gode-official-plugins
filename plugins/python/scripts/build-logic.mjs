export function selectedPlatforms(requested, supported) {
  const platforms = requested.length ? [...new Set(requested)] : [...supported]
  for (const platform of platforms)
    if (!supported.includes(platform)) throw new Error(`Unsupported plugin platform: ${platform}`)
  return platforms
}

export function assertLockedPackages(lock) {
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/'))
      throw new Error(`Unpinned package URL: ${name}`)
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? ''))
      throw new Error(`Missing SHA-512 integrity: ${name}`)
  }
}
