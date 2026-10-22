import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginSettingValue } from '@gode/plugin-sdk'
import type { PluginContext, SyncedMap, SyncedSet } from '@gode/plugin-sdk/plugin'
import de from '../../i18n/de.json'
import en from '../../i18n/en.json'
import es from '../../i18n/es.json'
import fr from '../../i18n/fr.json'
import ja from '../../i18n/ja.json'
import ko from '../../i18n/ko.json'
import ptBR from '../../i18n/pt-BR.json'
import ru from '../../i18n/ru.json'
import zhHans from '../../i18n/zh-Hans.json'
import zhHant from '../../i18n/zh-Hant.json'
import pageSettings from '../../page/settings.ts'
import actions from '../../page/actions.ts'
import views from '../../page/views.ts'
import sync from '../../page/sync.ts'
import identity from '../../plugin.json'
import type { Names } from '../../src/names.ts'
import type { ModelFile } from '../../src/models/download.ts'

export const manifest = {
  ...identity,
  groups: pageSettings,
  actions,
  views,
  stores: sync,
  strings: {
    de,
    en,
    es,
    fr,
    ja,
    ko,
    'pt-BR': ptBR,
    ru,
    'zh-Hans': zhHans,
    'zh-Hant': zhHant,
  },
}

export async function fixture(
  listener: (request: IncomingMessage, response: ServerResponse) => unknown,
): Promise<{
  directory: string
  url: string
  close(): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'gode-voice-'))
  const server = createServer((request, response) => {
    void (async () => listener(request, response))().catch((error: Error) =>
      response.destroy(error),
    )
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')
  return {
    directory,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export function model(file: string, url: string, body: string): ModelFile {
  return {
    file,
    url,
    size: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

export function wav(seconds: number): Buffer {
  const bytes = seconds * 32000
  const audio = Buffer.alloc(44 + bytes)
  audio.write('RIFF')
  audio.writeUInt32LE(36 + bytes, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(16000, 24)
  audio.writeUInt32LE(32000, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(bytes, 40)
  pcm(seconds).copy(audio, 44)
  return audio
}

export function pcm(seconds: number, { db = -20, fundamental = 160, syllables = 4 } = {}): Buffer {
  const samples = new Float64Array(Math.round(seconds * 16000))
  let power = 0
  for (let index = 0; index < samples.length; index++) {
    const time = index / 16000
    let tone = 0
    for (let harmonic = 1; harmonic * fundamental < 3500; harmonic++) {
      const frequency = harmonic * fundamental
      const emphasis =
        0.1 / harmonic +
        Math.exp(-(((frequency - 700) / 220) ** 2)) +
        0.5 * Math.exp(-(((frequency - 1400) / 300) ** 2)) +
        0.2 * Math.exp(-(((frequency - 2400) / 400) ** 2))
      tone += emphasis * Math.sin(2 * Math.PI * frequency * time)
    }
    const envelope = ((1 - Math.cos(2 * Math.PI * syllables * time)) / 2) ** 2
    samples[index] = tone * envelope
    power += samples[index]! ** 2
  }
  const scale = 10 ** (db / 20) / Math.sqrt(power / samples.length)
  const audio = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index++)
    audio.writeInt16LE(
      Math.round(Math.max(-1, Math.min(32767 / 32768, samples[index]! * scale)) * 32768),
      index * 2,
    )
  return audio
}

export function noise(seconds: number, { db = -39, peaks = true, seed = 1 } = {}): Buffer {
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const audio = Buffer.alloc(Math.round(seconds * 32000))
  for (let offset = 0; offset < audio.length; offset += 2) {
    let sample = (random() * 2 - 1) * Math.sqrt(3) * 10 ** (db / 20)
    if (peaks && random() < 0.0004) sample = Math.sign(sample) * 10 ** (-22 / 20)
    audio.writeInt16LE(Math.round(sample * 32768), offset)
  }
  return audio
}

export function settings(
  overrides: Partial<Record<Names['settings'], PluginSettingValue>>,
): Record<Names['settings'], PluginSettingValue> {
  return {
    ...Object.fromEntries(
      pageSettings.flatMap((group) =>
        group.fields.map((field) => [field.key, 'default' in field ? field.default : '']),
      ),
    ),
    ...overrides,
  } as Record<Names['settings'], PluginSettingValue>
}

export function testSynced(): PluginContext<Names>['synced'] {
  const terms = new Map<string, string>()
  const vocabulary = new Map<string, string>()
  const forgotten = new Set<string>()
  const map = (entries: Map<string, string>): SyncedMap => ({
    get size() {
      return entries.size
    },
    has: (key) => entries.has(key),
    get: (key) => entries.get(key),
    entries: () => [...entries],
    set: (key, value) => {
      if (!entries.has(key) && entries.size === 1000) throw new RangeError('Store is full')
      entries.set(key, value)
    },
    delete: (key) => {
      entries.delete(key)
    },
    clear: () => {
      entries.clear()
    },
    onChange: () => () => {},
  })
  const set: SyncedSet = {
    get size() {
      return forgotten.size
    },
    has: (key) => forgotten.has(key),
    values: () => [...forgotten],
    add: (key) => {
      if (!forgotten.has(key) && forgotten.size === 1000) throw new RangeError('Store is full')
      forgotten.add(key)
    },
    delete: (key) => {
      forgotten.delete(key)
    },
    clear: () => {
      forgotten.clear()
    },
    onChange: () => () => {},
  }
  return ((id: 'terms' | 'vocabulary' | 'forgotten') =>
    id === 'forgotten'
      ? set
      : map(id === 'terms' ? terms : vocabulary)) as PluginContext<Names>['synced']
}

export function emptyStores() {
  return {
    terms: { kind: 'map' as const, entries: {} },
    vocabulary: { kind: 'map' as const, entries: {} },
    forgotten: { kind: 'set' as const, entries: {} },
  }
}
