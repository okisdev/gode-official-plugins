import { expect, test } from '@gode/plugin-sdk/test'
import { applyVocabulary } from '../../src/recognition/vocabulary-logic.ts'

test.each([
  ['我们有一个 G O D E One，这个 GODE One', ['Gode One'], '我们有一个 Gode One，这个 GODE One'],
  ['还有 Agent Doc 这个东西', ['agentdoc'], '还有 agentdoc 这个东西'],
  ['重新部署一些 Relay', ['relay'], '重新部署一些 Relay'],
  ['把 use composer text 抽出来', ['useComposerText'], '把 useComposerText 抽出来'],
  ['agent documentation', ['agentdoc'], 'agent documentation'],
  ['a b', ['ab'], 'a b'],
  ['用 Assistant UI 和 assistantui 做', ['assistant-ui'], '用 assistant-ui 和 assistant-ui 做'],
  ['ASSISTANT-UI 和 Gode', ['assistant-ui', 'gode'], 'ASSISTANT-UI 和 Gode'],
  ['打开 next JS', ['Next.js'], '打开 Next.js'],
  ['我在用 Cloud Code 写代码', ['Claude Code'], '我在用 Claude Code 写代码'],
  ['用cloud code跑一下，再开 Cloud Code', ['Claude Code'], '用Claude Code跑一下，再开 Claude Code'],
  ['Claude Coat and Clod Code', ['Claude Code'], 'Claude Code and Claude Code'],
  ['把服务部署到 Gode Cloud 上', ['Claude Code'], '把服务部署到 Gode Cloud 上'],
  ['the cloud is down', ['Claude Code'], 'the cloud is down'],
  ['ask Claude could you check', ['Claude Code'], 'ask Claude could you check'],
  ['claude code 很好用', ['Claude Code'], 'claude code 很好用'],
  ['Cloud Kit 和 cloud, code', ['Claude Code'], 'Cloud Kit 和 cloud, code'],
  ['Cloud Coat', ['Claude Code'], 'Cloud Coat'],
  ['打开 Next JS App', ['Next.js App'], '打开 Next.js App'],
  ['react natives 和 React Native', ['React Native'], 'React Native 和 React Native'],
])('applies vocabulary to %s', (text, vocabulary, expected) =>
  expect(applyVocabulary(text, vocabulary)).toBe(expected),
)
