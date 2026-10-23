import { lockedNpmServer } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  bundle: 'vscode-langservers-extracted/lib/json-language-server/node/jsonServerMain.js',
})
