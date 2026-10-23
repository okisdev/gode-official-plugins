import { lockedNpmServer } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  bundle: 'vscode-langservers-extracted/lib/css-language-server/node/cssServerNodeMain.js',
  omit: ['vscode-langservers-extracted/bin/**'],
})
