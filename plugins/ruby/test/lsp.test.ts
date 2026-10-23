import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import { rubyLspVersion } from '../src/install.ts'
import plugin from '../src/main.ts'

const ruby = findProgram('ruby')
const modernRuby =
  ruby !== null && Number(execFileSync(ruby, ['-e', 'print RUBY_VERSION.to_i']).toString()) >= 3

test.skipIf(!built() || !modernRuby)(
  'the installed ruby-lsp answers LSP initialize from the built archive',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'ruby' })
    expect(session.launch.kind).toBe('program')
    expect(existsSync(session.launch.path)).toBe(true)
    expect(session.launch.args).toEqual([`_${rubyLspVersion}_`])
    const home = dirname(dirname(session.launch.path))
    expect(session.launch.env).toEqual({
      GEM_HOME: home,
      BUNDLE_GEMFILE: '',
    })
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  300_000,
)
