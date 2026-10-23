import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineLanguageServer } from '@gode/plugin-sdk/plugin'
import { installRubyLsp, rubyLspVersion } from './install.ts'

export default defineLanguageServer(async (paths, request) => {
  const home = await installRubyLsp(paths.data)
  const hasGemfile = ['Gemfile', 'gems.rb'].some((name) => existsSync(join(request.root, name)))
  return {
    kind: 'program',
    path: home.executable,
    args: [`_${rubyLspVersion}_`, ...(hasGemfile ? ['--use-launcher'] : [])],
    env: {
      GEM_HOME: home.directory,
      ...(!hasGemfile && { BUNDLE_GEMFILE: '' }),
    },
  }
})
