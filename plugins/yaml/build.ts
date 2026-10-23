import { lockedNpmServer } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  omit: ['yaml-language-server/out/server/test/**'],
})
