import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test.skipIf(!built())(
  'the unpacked Svelte server answers plain LSP in script and markup',
  async () => {
    const { project, launch, send, receive, request, initialize } = await startLanguageServer(
      plugin,
      { language: 'svelte' },
    )
    expect(launch.kind).toBe('program')
    const uri = pathToFileURL(join(project, 'App.svelte')).href
    const source = [
      '<script lang="ts">',
      "  const greeting: string = 'Hello Svelte'",
      '  greeting',
      '  greeting.to',
      '</script>',
      '',
      '<div>{greeting}</div>',
    ].join('\n')
    await writeFile(join(project, 'App.svelte'), source)
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
      params: { textDocument: { uri, languageId: 'svelte', version: 1, text: source } },
    })
    const hover = await request(2, 'textDocument/hover', {
      textDocument: { uri },
      position: { line: 2, character: 4 },
    })
    expect(hover.error).toBeUndefined()
    expect(JSON.stringify(hover.result)).toContain('greeting')
    const templateHover = await request(3, 'textDocument/hover', {
      textDocument: { uri },
      position: { line: 6, character: 8 },
    })
    expect(templateHover.error).toBeUndefined()
    expect(JSON.stringify(templateHover.result)).toContain('greeting')
    const completion = await request(4, 'textDocument/completion', {
      textDocument: { uri },
      position: { line: 3, character: 13 },
      context: { triggerKind: 1 },
    })
    expect(completion.error).toBeUndefined()
    expect(JSON.stringify(completion.result)).toContain('toString')
    const definition = await request(5, 'textDocument/definition', {
      textDocument: { uri },
      position: { line: 2, character: 4 },
    })
    expect(definition.error).toBeUndefined()
    expect(JSON.stringify(definition.result)).toContain('"line":1')
    const broken = source.replace('const greeting: string', 'const greeting: number')
    send({
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: broken }] },
    })
    const diagnostics = await Promise.race([
      receive(
        (message) =>
          message.method === 'textDocument/publishDiagnostics' &&
          JSON.stringify(message.params).includes('number'),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('No diagnostics for the wrong type')), 10_000),
      ),
    ])
    expect(JSON.stringify(diagnostics.params)).toContain('number')
  },
  60_000,
)
