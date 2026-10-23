import { lockedNpmServer, typescriptTools } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  bundle: '@astrojs/language-server/bin/nodeServer.js',
  keep: ['typescript', '@astrojs/astro2tsx', 'vscode-json-languageservice'],
  omit: typescriptTools,
})
