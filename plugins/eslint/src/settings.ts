export const settings = {
  validate: 'on',
  run: 'onType',
  packageManager: 'npm',
  workingDirectory: { mode: 'auto' },
  nodePath: null,
  useESLintClass: true,
  format: false,
  quiet: false,
  onIgnoredFiles: 'off',
  rulesCustomizations: [],
  problems: { shortenToSingleLine: false },
  codeAction: {
    disableRuleComment: {
      enable: true,
      location: 'separateLine',
      commentStyle: 'line',
    },
    showDocumentation: { enable: true },
  },
  codeActionOnSave: { mode: 'all' },
  experimental: { useFlatConfig: false },
} as const
