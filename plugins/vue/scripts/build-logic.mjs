export function selectedPlatforms(requested, supported) {
  const platforms = requested.length ? [...new Set(requested)] : [...supported]
  for (const platform of platforms)
    if (!supported.includes(platform)) throw new Error(`Unsupported plugin platform: ${platform}`)
  return platforms
}

export function verifyServerLock(manifest, lock) {
  if (lock.lockfileVersion !== 3) throw new Error('Server lockfile must use npm lockfile v3')
  const root = lock.packages?.['']
  if (!root || JSON.stringify(root.dependencies) !== JSON.stringify(manifest.dependencies))
    throw new Error('Server dependencies differ from the lockfile')
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (lock.packages[`node_modules/${name}`]?.version !== version)
      throw new Error(`Server dependency is not pinned: ${name}`)
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? ''))
      throw new Error(`Server dependency lacks SHA-512 integrity: ${path}`)
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/'))
      throw new Error(`Server dependency has an unexpected source: ${path}`)
  }
}
