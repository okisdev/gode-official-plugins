import { expect, test } from '@gode/plugin-sdk/test'
import { PluginError } from '@gode/plugin-sdk/plugin'
import { jj } from '../src/process.ts'
import { fixture } from './fixtures/repository.ts'

test('unrecognized jj failure preserves stderr without a cause', async () => {
  const { path } = await fixture()
  const logs: string[] = []
  try {
    await jj(path, ['does-not-exist'], (_level, message) => logs.push(message))
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError)
    const reply = (error as PluginError).text
    expect(reply.output).toBe(true)
    expect(reply.cause).toBeNull()
    expect(reply.message).toContain('unrecognized subcommand')
  }
  expect(logs).toHaveLength(1)
})
