# Gode official plugins

Gode's own plugins, each a workspace package in `plugins/` with its `manifest.json`, the process Gode runs and the build that packs it; the Gode repository at `../gode` holds the host that installs and runs them (`apps/desktop/src/main/plugins/AGENTS.md`) and `packages/plugin-sdk`, the contract between the two, with its README the guide to writing and publishing any plugin.

## Commands

- `pnpm test`, `pnpm typecheck` and `pnpm lint`: run all three before calling any change done; `pnpm lint:fix` applies oxlint's and oxfmt's fixes.
- `pnpm --dir plugins/<id> build [platform...]`: runs `gode-plugin build` for the language plugins, bundling their process and staging their pinned server into archives under `out`; voice-input still downloads pinned programs with `gh release download`, so its build needs the GitHub CLI signed in.
- In the Codex sandbox run Vitest as `pnpm vitest run --configLoader runner` inside the package, and read tests that fail to listen on `127.0.0.1` as the sandbox, not the change.

## Rules

- Take `@gode/plugin-sdk` and `@gode/format` from `../gode` through `link:` until the SDK is published, and change the SDK there, never by copying it here, because the host and every plugin must share one contract.
- Depend on Gode only through `@gode/plugin-sdk`, never on Gode's apps or another package's internals, as `scripts/plugins.test.ts` asserts, because a plugin ships apart from the app, runs against versions of Gode it was not built with, and must build the way a plugin from any other publisher would.
- Pack every archive with `packPlugin` from `@gode/plugin-sdk/pack`, so releases and the host see the same layout and name for every publisher's plugins.
- Declare every setting, action and word a person sees in the manifest, and report state only as a `PluginStatus` or view data naming those words, because Gode draws a plugin's interface itself and never runs plugin code in a window.
- Give every manifest string in every language Gode speaks, written by `../gode/apps/desktop/src/shared/i18n/AGENTS.md` and its language folders, and keep `scripts/plugins.test.ts` passing.
- Pin every file a plugin or its build downloads by URL and SHA-256, verify it before use, and never leave a partial file under its final name.
- Keep what a plugin downloads or keeps in `paths.data`, never in the read-only `paths.plugin`, let every call stand on its own because calls overlap, and stop the programs it started when Gode sends `SIGTERM`.
- Raise `minimumAppVersion` to the first Gode that has each capability the plugin uses.
- Raise a plugin's `version` for every change that ships, because Gode installs a version once and updates only to a newer one.
- Release with `pnpm release <id>` and upload the catalog with `pnpm catalog` only when the owner asks, because installed copies update on their own within six hours.
