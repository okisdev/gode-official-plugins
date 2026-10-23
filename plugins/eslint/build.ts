import { lockedNpmServer } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  bundle: 'vscode-langservers-extracted/lib/eslint-language-server/eslintServer.js',
})
