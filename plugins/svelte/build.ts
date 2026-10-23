import { lockedNpmServer, typescriptTools } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  omit: [...typescriptTools, 'prettier/{bin,internal,plugins}/**', 'prettier/standalone.*'],
})
