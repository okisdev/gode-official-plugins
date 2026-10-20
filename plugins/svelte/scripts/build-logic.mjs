export function selectedPlatforms(requested, supported) {
  const platforms = requested.length ? [...new Set(requested)] : [...supported]
  for (const platform of platforms)
    if (!supported.includes(platform)) throw new Error(`Unsupported plugin platform: ${platform}`)
  return platforms
}

export function verifyLockfile(lock, version) {
  if (
    lock.lockfileVersion !== 3 ||
    lock.packages?.['']?.dependencies?.['svelte-language-server'] !== version
  )
    throw new Error('Server lockfile does not pin the selected Svelte language server')
  const server = lock.packages['node_modules/svelte-language-server']
  if (server?.version !== version || server.bin?.svelteserver !== 'bin/server.js')
    throw new Error('Server lockfile does not pin the published server entry')
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue
    if (
      !entry.resolved?.startsWith('https://registry.npmjs.org/') ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? '')
    )
      throw new Error(`Server lockfile lacks a registry URL and SHA-512 integrity for ${name}`)
  }
}
