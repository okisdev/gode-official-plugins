import type { PluginActions } from '@gode/plugin-sdk'

export default [
  {
    id: 'downloadModel',
    title: 'action.downloadModel',
    visibleWhen: {
      key: 'engine',
      values: ['local'],
    },
  },
  {
    id: 'stopDownload',
    title: 'action.stopDownload',
  },
  {
    id: 'removeModel',
    title: 'action.removeModel',
    confirm: 'confirm.removeModel',
    visibleWhen: {
      key: 'engine',
      values: ['local'],
    },
  },
  {
    id: 'downloadPolishModel',
    title: 'action.downloadPolishModel',
    visibleWhen: {
      key: 'polishModel',
      values: ['qwen3.5-4b', 'qwen3.5-2b'],
    },
  },
  {
    id: 'removePolishModel',
    title: 'action.removePolishModel',
    confirm: 'confirm.removePolishModel',
    visibleWhen: {
      key: 'polishModel',
      values: ['qwen3.5-4b', 'qwen3.5-2b'],
    },
  },
  {
    id: 'checkServer',
    title: 'action.checkServer',
    visibleWhen: {
      key: 'engine',
      values: ['server'],
    },
  },
  {
    id: 'checkPolishService',
    title: 'action.checkPolishService',
    visibleWhen: {
      key: 'polishModel',
      values: ['server'],
    },
  },
  {
    id: 'clearHistory',
    title: 'action.clearHistory',
    confirm: 'confirm.clearHistory',
  },
  {
    id: 'clearMemory',
    title: 'action.clearMemory',
    confirm: 'confirm.clearMemory',
  },
] as const satisfies PluginActions
