const { createConnection } = require('vscode-languageserver/node')
const { startServer } = require('../dist/src/server')

startServer({ connection: createConnection() })
