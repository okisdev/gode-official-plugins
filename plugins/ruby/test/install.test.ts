import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import { installRubyLsp, rubyLspVersion } from '../src/install.ts'
import plugin from '../src/main.ts'

async function fixture(): Promise<{ root: string; data: string; calls: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gode-ruby-install-'))
  const ruby = join(root, 'ruby')
  const gem = join(root, 'gem')
  await writeFile(ruby, '#!/bin/sh\nprintf "%s" "${RUBY_TEST_VERSION:-3.4.1}"\n')
  await writeFile(
    gem,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RUBY_TEST_CALLS"\nif [ "$RUBY_TEST_FAIL" = yes ]; then exit 1; fi\n/bin/sleep 0.1\n/bin/mkdir -p "$GEM_HOME/bin"\nprintf "#!/bin/sh\\nexit 0\\n" > "$GEM_HOME/bin/ruby-lsp"\n/bin/chmod 755 "$GEM_HOME/bin/ruby-lsp"\n',
  )
  await Promise.all([chmod(ruby, 0o755), chmod(gem, 0o755)])
  return { root, data: join(root, 'data'), calls: join(root, 'calls') }
}

test('requires ruby and gem on PATH before checking an installed server', async () => {
  const { root, data } = await fixture()
  const previousPath = process.env.PATH
  try {
    process.env.PATH = ''
    await expect(installRubyLsp(data)).rejects.toMatchObject({ text: { message: 'missing' } })
    process.env.PATH = root
    await rm(join(root, 'gem'))
    await expect(installRubyLsp(data)).rejects.toMatchObject({ text: { message: 'missing' } })
  } finally {
    process.env.PATH = previousPath
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses a Ruby older than ruby-lsp supports', async () => {
  const { root, data } = await fixture()
  const previousPath = process.env.PATH
  try {
    process.env.PATH = root
    process.env.RUBY_TEST_VERSION = '2.6.10'
    await expect(installRubyLsp(data)).rejects.toMatchObject({ text: { message: 'tooOld' } })
  } finally {
    process.env.PATH = previousPath
    delete process.env.RUBY_TEST_VERSION
    await rm(root, { recursive: true, force: true })
  }
})

test('installs one pinned gem across overlapping launches and reuses it', async () => {
  const { root, data, calls } = await fixture()
  const previousPath = process.env.PATH
  const previousCalls = process.env.RUBY_TEST_CALLS
  try {
    process.env.PATH = root
    process.env.RUBY_TEST_CALLS = calls
    const [first, second] = await Promise.all([installRubyLsp(data), installRubyLsp(data)])
    expect(first).toEqual({
      directory: join(data, 'ruby-lsp', rubyLspVersion),
      executable: join(data, 'ruby-lsp', rubyLspVersion, 'bin', 'ruby-lsp'),
    })
    expect(second).toEqual(first)
    expect(await installRubyLsp(data)).toEqual(first)
    const invocation = (await readFile(calls, 'utf8')).trim().split('\n')
    expect(invocation).toHaveLength(1)
    expect(invocation[0]).toContain(`install ruby-lsp --version ${rubyLspVersion}`)
    expect(invocation[0]).toContain('--no-user-install')
    expect(await readdir(join(data, 'ruby-lsp'))).toEqual([rubyLspVersion])
  } finally {
    process.env.PATH = previousPath
    if (previousCalls === undefined) delete process.env.RUBY_TEST_CALLS
    else process.env.RUBY_TEST_CALLS = previousCalls
    await rm(root, { recursive: true, force: true })
  }
})

test('cleans up a failed install and allows retry', async () => {
  const { root, data, calls } = await fixture()
  const previousPath = process.env.PATH
  const previousCalls = process.env.RUBY_TEST_CALLS
  const previousFail = process.env.RUBY_TEST_FAIL
  try {
    process.env.PATH = root
    process.env.RUBY_TEST_CALLS = calls
    process.env.RUBY_TEST_FAIL = 'yes'
    await expect(installRubyLsp(data)).rejects.toThrow()
    expect(await readdir(join(data, 'ruby-lsp'))).toEqual([])
    delete process.env.RUBY_TEST_FAIL
    expect((await installRubyLsp(data)).executable).toBe(
      join(data, 'ruby-lsp', rubyLspVersion, 'bin', 'ruby-lsp'),
    )
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(2)
  } finally {
    process.env.PATH = previousPath
    if (previousCalls === undefined) delete process.env.RUBY_TEST_CALLS
    else process.env.RUBY_TEST_CALLS = previousCalls
    if (previousFail === undefined) delete process.env.RUBY_TEST_FAIL
    else process.env.RUBY_TEST_FAIL = previousFail
    await rm(root, { recursive: true, force: true })
  }
})

test('launches the upstream bundle setup when a project has a Gemfile', async () => {
  const { root, data, calls } = await fixture()
  const previousPath = process.env.PATH
  const previousCalls = process.env.RUBY_TEST_CALLS
  try {
    process.env.PATH = root
    process.env.RUBY_TEST_CALLS = calls
    const project = join(root, 'project')
    await mkdir(project)
    await writeFile(join(project, 'Gemfile'), 'source "https://rubygems.org"\n')
    const launch = await plugin.launch({ plugin: root, data }, { root: project, language: 'ruby' })
    expect(launch.args).toEqual([`_${rubyLspVersion}_`, '--use-launcher'])
    expect(launch.env).toEqual({ GEM_HOME: join(data, 'ruby-lsp', rubyLspVersion) })
  } finally {
    process.env.PATH = previousPath
    if (previousCalls === undefined) delete process.env.RUBY_TEST_CALLS
    else process.env.RUBY_TEST_CALLS = previousCalls
    await rm(root, { recursive: true, force: true })
  }
})
