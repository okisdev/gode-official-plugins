import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test.skipIf(!built())(
  'the unpacked HTML server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'html' })
    expect(session.launch.kind).toBe('script')
    expect(existsSync(session.launch.path)).toBe(true)
    const initialized = await session.initialize({
      capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } },
    })
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({
      capabilities: {
        completionProvider: expect.any(Object),
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: true,
      },
    })
    session.send({ method: 'initialized', params: {} })
    const uri = pathToFileURL(join(session.project, 'index.html')).href
    session.send({
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'html', version: 1, text: '<bo' } },
    })
    const completion = await session.request(2, 'textDocument/completion', {
      textDocument: { uri },
      position: { line: 0, character: 3 },
    })
    expect(completion.error).toBeUndefined()
    expect(JSON.stringify(completion.result)).toContain('body')
  },
  30_000,
)
