import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class AtomicFile {
  private writes = Promise.resolve()

  constructor(private readonly path: string) {}

  async read(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'))
    } catch {
      return undefined
    }
  }

  write(value: unknown): void {
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        const temporary = `${this.path}.tmp`
        try {
          await writeFile(temporary, JSON.stringify(value))
          await rename(temporary, this.path)
        } finally {
          await rm(temporary, { force: true })
        }
      })
      .catch(() => {})
  }

  async dispose(): Promise<void> {
    await this.writes
  }
}
