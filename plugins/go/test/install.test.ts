import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import { installGopls, goplsVersion } from '../src/install.ts'

async function fixture(): Promise<{ root: string; data: string; calls: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gode-go-install-'))
  const go = join(root, 'go')
  await writeFile(
    go,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GO_TEST_CALLS"\nif [ "$GO_TEST_FAIL" = yes ]; then exit 1; fi\n/bin/sleep 0.1\nprintf "#!/bin/sh\\nexit 0\\n" > "$GOBIN/gopls"\n/bin/chmod 755 "$GOBIN/gopls"\n',
  )
  await chmod(go, 0o755)
  return { root, data: join(root, 'data'), calls: join(root, 'calls') }
}

test('requires go on PATH even before checking an installed server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gode-go-missing-'))
  const previous = process.env.PATH
  try {
    process.env.PATH = ''
    await expect(installGopls(join(root, 'data'))).rejects.toMatchObject({
      text: { message: 'missing' },
    })
  } finally {
    process.env.PATH = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('installs a pinned version once across overlapping launches and reuses it', async () => {
  const { root, data, calls } = await fixture()
  const previousPath = process.env.PATH
  const previousCalls = process.env.GO_TEST_CALLS
  try {
    process.env.PATH = root
    process.env.GO_TEST_CALLS = calls
    const [first, second] = await Promise.all([installGopls(data), installGopls(data)])
    expect(first).toBe(join(data, 'gopls', goplsVersion, 'gopls'))
    expect(second).toBe(first)
    expect(await installGopls(data)).toBe(first)
    expect(await readFile(calls, 'utf8')).toBe(`install golang.org/x/tools/gopls@${goplsVersion}\n`)
    expect(await readdir(join(data, 'gopls'))).toEqual([goplsVersion])
  } finally {
    process.env.PATH = previousPath
    process.env.GO_TEST_CALLS = previousCalls
    await rm(root, { recursive: true, force: true })
  }
})

test('cleans up a failed install and retries', async () => {
  const { root, data, calls } = await fixture()
  const previousPath = process.env.PATH
  const previousCalls = process.env.GO_TEST_CALLS
  try {
    process.env.PATH = root
    process.env.GO_TEST_CALLS = calls
    process.env.GO_TEST_FAIL = 'yes'
    await expect(installGopls(data)).rejects.toThrow()
    expect(await readdir(join(data, 'gopls'))).toEqual([])
    delete process.env.GO_TEST_FAIL
    expect(await installGopls(data)).toBe(join(data, 'gopls', goplsVersion, 'gopls'))
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(2)
  } finally {
    process.env.PATH = previousPath
    process.env.GO_TEST_CALLS = previousCalls
    delete process.env.GO_TEST_FAIL
    await rm(root, { recursive: true, force: true })
  }
})
