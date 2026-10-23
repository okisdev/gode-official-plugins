import { lockedNpmServer } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  bundle: 'dockerfile-language-server-nodejs/lib/server.js',
})
