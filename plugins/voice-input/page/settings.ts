import type { PluginSettings } from '@gode/plugin-sdk'

export default [
  {
    title: 'group.recognition',
    fields: [
      {
        key: 'engine',
        kind: 'choice',
        title: 'engine.title',
        options: [
          {
            value: 'local',
            title: 'engine.local',
          },
          {
            value: 'server',
            title: 'engine.server',
          },
        ],
        default: 'local',
      },
      {
        key: 'localModel',
        kind: 'choice',
        title: 'localModel.title',
        description: 'localModel.description',
        options: [
          {
            value: 'qwen3-asr-1.7b',
            title: 'localModel.recommended',
          },
          {
            value: 'qwen3-asr-0.6b',
            title: 'localModel.smaller',
          },
        ],
        default: 'qwen3-asr-1.7b',
        visibleWhen: {
          key: 'engine',
          values: ['local'],
        },
      },
      {
        key: 'serverURL',
        kind: 'text',
        format: 'url',
        title: 'serverURL.title',
        description: 'serverURL.description',
        placeholder: 'https://api.openai.com/v1',
        default: '',
        visibleWhen: {
          key: 'engine',
          values: ['server'],
        },
      },
      {
        key: 'apiKey',
        kind: 'secret',
        title: 'apiKey.title',
        description: 'apiKey.description',
        visibleWhen: {
          key: 'engine',
          values: ['server'],
        },
      },
      {
        key: 'model',
        kind: 'text',
        format: 'plain',
        title: 'model.title',
        placeholder: 'gpt-4o-transcribe',
        default: 'gpt-4o-transcribe',
        visibleWhen: {
          key: 'engine',
          values: ['server'],
        },
      },
    ],
  },
  {
    title: 'group.text',
    fields: [
      {
        key: 'language',
        kind: 'choice',
        title: 'language.title',
        description: 'language.description',
        options: [
          {
            value: 'auto',
            title: 'language.auto',
          },
          {
            value: 'zh',
            title: 'language.zh',
          },
          {
            value: 'en',
            title: 'language.en',
          },
          {
            value: 'ja',
            title: 'language.ja',
          },
          {
            value: 'ko',
            title: 'language.ko',
          },
          {
            value: 'de',
            title: 'language.de',
          },
          {
            value: 'fr',
            title: 'language.fr',
          },
          {
            value: 'es',
            title: 'language.es',
          },
          {
            value: 'pt',
            title: 'language.pt',
          },
          {
            value: 'ru',
            title: 'language.ru',
          },
        ],
        default: 'auto',
      },
      {
        key: 'removeFillers',
        kind: 'toggle',
        title: 'removeFillers.title',
        description: 'removeFillers.description',
        default: true,
      },
      {
        key: 'polish',
        kind: 'toggle',
        title: 'polish.title',
        description: 'polish.description',
        default: false,
      },
    ],
  },
  {
    title: 'group.history',
    fields: [
      {
        key: 'keepHistory',
        kind: 'toggle',
        title: 'keepHistory.title',
        description: 'keepHistory.description',
        default: true,
      },
      {
        key: 'learnTerms',
        kind: 'toggle',
        title: 'learnTerms.title',
        description: 'learnTerms.description',
        default: true,
      },
    ],
  },
] as const satisfies PluginSettings
