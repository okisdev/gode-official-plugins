import { lockedNpmServer } from '@gode/plugin-sdk/build'

export default lockedNpmServer({
  omit: [
    'basedpyright/index.js',
    'basedpyright/dist/pyright.js',
    'basedpyright/dist/typeshed-fallback/stubs/pywin32/**',
  ],
})
