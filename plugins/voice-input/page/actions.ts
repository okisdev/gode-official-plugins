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
      key: 'polish',
      values: ['true'],
    },
  },
  {
    id: 'removePolishModel',
    title: 'action.removePolishModel',
    confirm: 'confirm.removePolishModel',
    visibleWhen: {
      key: 'polish',
      values: ['true'],
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
