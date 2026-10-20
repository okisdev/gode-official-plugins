import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface ModelFile {
  file: string
  url: string
  size: number
  sha256: string
}

export async function modelsPresent(
  directory: string,
  models: readonly ModelFile[],
): Promise<boolean> {
  const found = await Promise.all(
    models.map(async (model) => {
      try {
        const info = await stat(join(directory, model.file))
        return info.isFile() && info.size === model.size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    }),
  )
  return found.every(Boolean)
}

export async function clearPartials(
  directory: string,
  models: readonly ModelFile[],
): Promise<void> {
  await Promise.all(
    models.map((model) => rm(join(directory, `${model.file}.partial`), { force: true })),
  )
}

export async function downloadModels(
  directory: string,
  models: readonly ModelFile[],
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  const total = models.reduce((sum, model) => sum + model.size, 0)
  let done = 0
  try {
    progress(0, total)
    for (const model of models) {
      signal.throwIfAborted()
      const partial = join(directory, `${model.file}.partial`)
      const response = await fetch(model.url, { signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const hash = createHash('sha256')
      let size = 0
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length
            if (size > model.size) return callback(new Error(`Unexpected size for ${model.file}`))
            hash.update(chunk)
            progress(done + size, total)
            callback(null, chunk)
          },
        }),
        createWriteStream(partial),
        { signal },
      )
      if (size !== model.size || hash.digest('hex') !== model.sha256)
        throw new Error(`Integrity check failed for ${model.file}`)
      signal.throwIfAborted()
      await rename(partial, join(directory, model.file))
      done += size
    }
  } finally {
    await clearPartials(directory, models)
  }
}
