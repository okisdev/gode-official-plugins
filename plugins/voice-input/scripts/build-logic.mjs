import { basename } from 'node:path'

export function selectedPlatforms(requested, supported) {
  const platforms = requested.length ? [...new Set(requested)] : [...supported]
  for (const platform of platforms)
    if (!supported.includes(platform)) throw new Error(`Unsupported plugin platform: ${platform}`)
  return platforms
}

export function verifySHA256(actual, expected, file) {
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${file}`)
}

export function runtimeFiles(entries, directory, platform) {
  const library = platform.startsWith('darwin-')
    ? /^lib(?:ggml(?:-[a-z0-9-]+)?|llama(?:-common|-server-impl)?|mtmd)(?:\.\d+)*\.dylib$/
    : /^lib(?:ggml(?:-[a-z0-9_.-]+)?|llama(?:-common|-server-impl)?|mtmd)\.so(?:\.\d+)*$/
  const files = entries
    .filter((entry) => {
      if (!entry.startsWith(`${directory}/`) || entry.slice(directory.length + 1).includes('/'))
        return false
      const name = basename(entry)
      return name === 'llama-server' || name === 'LICENSE' || library.test(name)
    })
    .sort()
  for (const file of ['llama-server', 'LICENSE'])
    if (!files.includes(`${directory}/${file}`)) throw new Error(`Runtime archive lacks ${file}`)
  if (!files.some((file) => library.test(basename(file))))
    throw new Error('Runtime archive lacks shared libraries')
  return files
}
