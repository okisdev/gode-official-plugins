import { lockedNpmServer, typescriptTools } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  bundle: '@vue/language-server/bin/vue-language-server.js',
  keep: ['typescript'],
  omit: typescriptTools,
})
