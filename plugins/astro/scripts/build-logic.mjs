export function selectedPlatforms(requested, supported) {
  const platforms = requested.length ? [...new Set(requested)] : [...supported]
  for (const platform of platforms)
    if (!supported.includes(platform)) throw new Error(`Unsupported plugin platform: ${platform}`)
  return platforms
}

export function verifyLock(lock, server) {
  if (lock.lockfileVersion !== 3) throw new Error('Server requires a version 3 npm lockfile')
  const root = lock.packages?.['']
  if (JSON.stringify(root?.dependencies) !== JSON.stringify(server.dependencies))
    throw new Error('Server lockfile dependencies differ from package.json')
  for (const [name, version] of Object.entries(server.dependencies)) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Server dependency is not exact: ${name}`)
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue
    if (
      !name.startsWith('node_modules/') ||
      !/^\d+\.\d+\.\d+/.test(entry.version) ||
      !entry.resolved?.startsWith('https://registry.npmjs.org/') ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')
    )
      throw new Error(`Server lockfile package is not pinned by npm integrity: ${name}`)
  }
}
