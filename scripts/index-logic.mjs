import { pluginCatalogSchema, pluginKey } from '@gode/plugin-sdk'

export function localCatalog(archives, publicKey) {
  const plugins = new Map()
  for (const archive of archives) {
    const key = pluginKey(archive.manifest)
    const current = plugins.get(key)
    if (current && JSON.stringify(current.manifest) !== JSON.stringify(archive.manifest))
      throw new Error(`Inconsistent manifests for ${key}`)
    if (!current) plugins.set(key, { manifest: archive.manifest, platforms: new Set() })
    const platforms = plugins.get(key).platforms
    if (platforms.has(archive.platform))
      throw new Error(`Duplicate platform for ${key}: ${archive.platform}`)
    platforms.add(archive.platform)
  }
  if (!plugins.size) throw new Error('No plugin archives found')
  return pluginCatalogSchema.parse({
    plugins: [...plugins.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((key) => {
        const [publisher, id] = key.split('/')
        return { publisher, id, source: `${key}/releases.json`, publicKey }
      }),
  })
}
