export function selectedPlatforms(requested, supported) {
  const platforms = requested.length ? [...new Set(requested)] : [...supported]
  for (const platform of platforms)
    if (!supported.includes(platform)) throw new Error(`Unsupported plugin platform: ${platform}`)
  return platforms
}

export function verifySHA256(actual, expected, file) {
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${file}`)
}
