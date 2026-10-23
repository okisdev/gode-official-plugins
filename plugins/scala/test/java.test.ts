import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import { findJava } from '../src/java.ts'

test('finds Java 17 or newer after an older Java on PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gode-scala-java-'))
  try {
    const old = join(root, 'old')
    const current = join(root, 'current')
    await Promise.all([mkdir(old), mkdir(current)])
    await writeFile(join(old, 'java'), '#!/bin/sh\necho \'openjdk version "11.0.1"\' >&2\n')
    await writeFile(join(current, 'java'), '#!/bin/sh\necho \'openjdk version "17.0.1"\' >&2\n')
    await Promise.all([chmod(join(old, 'java'), 0o755), chmod(join(current, 'java'), 0o755)])
    expect(findJava(old)).toBeUndefined()
    expect(findJava(`${old}${delimiter}${current}`)).toBe(join(current, 'java'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
