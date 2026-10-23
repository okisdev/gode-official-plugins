import { lockedNpmServer } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  bundle: 'vscode-langservers-extracted/lib/html-language-server/node/htmlServerNodeMain.js',
  omit: ['vscode-langservers-extracted/bin/**'],
})
