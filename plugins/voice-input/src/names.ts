import type { PluginOf } from '@gode/plugin-sdk'
import type strings from '../i18n/en.json'
import type actions from '../page/actions'
import type settings from '../page/settings'
import type sync from '../page/sync'
import type views from '../page/views'

export type Names = PluginOf<{
  strings: typeof strings
  settings: typeof settings
  sync: typeof sync
  actions: typeof actions
  views: typeof views
}>
