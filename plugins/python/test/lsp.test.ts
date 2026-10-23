import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test.skipIf(!built())(
  'the unpacked Python server answers plain LSP',
  async () => {
    const { project, launch, send, receive, request, initialize } = await startLanguageServer(
      plugin,
      { language: 'python' },
    )
    expect(launch.kind).toBe('script')
    const uri = pathToFileURL(join(project, 'main.py')).href
    const source = ['greeting: str = "Hello Python"', 'greeting', 'greeting.up'].join('\n')
    await writeFile(join(project, 'main.py'), source)
    const initialized = await initialize({
      capabilities: {
        textDocument: { hover: {}, completion: {}, definition: {}, publishDiagnostics: {} },
      },
    })
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
    send({ method: 'initialized', params: {} })
    send({
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'python', version: 1, text: source } },
    })
    const hover = await request(2, 'textDocument/hover', {
      textDocument: { uri },
      position: { line: 1, character: 3 },
    })
    expect(hover.error).toBeUndefined()
    expect(JSON.stringify(hover.result)).toContain('greeting')
    const completion = await request(4, 'textDocument/completion', {
      textDocument: { uri },
      position: { line: 2, character: 11 },
      context: { triggerKind: 1 },
    })
    expect(completion.error).toBeUndefined()
    expect(JSON.stringify(completion.result)).toContain('upper')
    const definition = await request(5, 'textDocument/definition', {
      textDocument: { uri },
      position: { line: 1, character: 3 },
    })
    expect(definition.error).toBeUndefined()
    expect(JSON.stringify(definition.result)).toContain('"line":0')
    const broken = source.replace('greeting: str', 'greeting: int')
    send({
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: broken }] },
    })
    const diagnostics = await Promise.race([
      receive(
        (message) =>
          message.method === 'textDocument/publishDiagnostics' &&
          JSON.stringify(message.params).includes('int'),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('No diagnostics for the wrong type')), 10_000),
      ),
    ])
    expect(JSON.stringify(diagnostics.params)).toContain('int')
  },
  60_000,
)
