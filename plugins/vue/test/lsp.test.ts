import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test.skipIf(!built())(
  'the unpacked Vue server answers plain LSP in script and template',
  async () => {
    const { project, launch, send, receive, request, initialize } = await startLanguageServer(
      plugin,
      { language: 'vue' },
    )
    expect(launch.kind).toBe('script')
    const uri = pathToFileURL(join(project, 'App.vue')).href
    const source = [
      '<script setup lang="ts">',
      "const greeting = 'Hello Vue'",
      'greeting',
      'greeting.to',
      '</script>',
      '<template>',
      '  <div>{{ greeting }}</div>',
      '</template>',
    ].join('\n')
    await writeFile(join(project, 'App.vue'), source)
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
      params: { textDocument: { uri, languageId: 'vue', version: 1, text: source } },
    })
    const scriptHover = await request(2, 'textDocument/hover', {
      textDocument: { uri },
      position: { line: 2, character: 3 },
    })
    expect(scriptHover.error).toBeUndefined()
    expect(scriptHover.result).toBeTruthy()
    const templateHover = await request(3, 'textDocument/hover', {
      textDocument: { uri },
      position: { line: 6, character: 12 },
    })
    expect(templateHover.error).toBeUndefined()
    expect(templateHover.result).toBeTruthy()
    const completion = await request(4, 'textDocument/completion', {
      textDocument: { uri },
      position: { line: 3, character: 11 },
      context: { triggerKind: 1 },
    })
    expect(completion.error).toBeUndefined()
    expect(JSON.stringify(completion.result)).toContain('toString')
    const definition = await request(5, 'textDocument/definition', {
      textDocument: { uri },
      position: { line: 2, character: 3 },
    })
    expect(definition.error).toBeUndefined()
    expect(JSON.stringify(definition.result)).toContain(uri)
    expect(JSON.stringify(definition.result)).toContain('"line":1')
    const broken = source
      .replace("const greeting = 'Hello Vue'", "const greeting: number = 'Hello Vue'")
      .replace('{{ greeting }}', '{{ unknownValue }}')
    send({
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: broken }] },
    })
    const diagnostics = await Promise.race([
      receive(
        (message) =>
          message.method === 'textDocument/publishDiagnostics' &&
          JSON.stringify(message.params).includes('unknownValue'),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('No diagnostics for unknownValue')), 5000),
      ),
    ])
    expect(JSON.stringify(diagnostics.params)).toContain('unknownValue')
    expect(JSON.stringify(diagnostics.params)).toContain('number')
  },
  30_000,
)
