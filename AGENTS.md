# Gode official plugins

Gode's own plugins, each a workspace package in `plugins/` laid out as the SDK README's "What a plugin is made of" describes; the Gode repository at `../gode` holds the host that installs and runs them (`apps/desktop/src/main/plugins/AGENTS.md`) and `packages/plugin-sdk`, the contract between the two, with its README the guide to writing and publishing any plugin.

## Commands

- `pnpm test`, `pnpm typecheck` and `pnpm lint`: run all three before calling any change done; tests run every plugin's `gode-plugin test` and `node --test` for `scripts/`, typecheck runs every plugin's `gode-plugin check` and TypeScript over `scripts/`, and `pnpm lint:fix` applies oxlint's and oxfmt's fixes.
- `pnpm --dir plugins/<id> build [platform...]`: runs `gode-plugin build`, assembling the archive's manifest from `plugin.json`, `page/`, `i18n/` and `icon.svg`, bundling its process and staging its pinned programs into archives under `out`; voice-input downloads with `gh release download`, so its build needs the GitHub CLI signed in.
- `pnpm --dir plugins/<id> check` checks the plugin's source files, all ten languages and TypeScript; `pnpm --dir plugins/<id> test` runs its `test/` files through the SDK, and failures to listen on `127.0.0.1` in the sandbox are environment findings.

## Rules

- Take `@gode/plugin-sdk` and `@gode/format` from `../gode` through `link:` until the SDK is published, and change the SDK there, never by copying it here, because the host and every plugin must share one contract.
- Depend on Gode only through `@gode/plugin-sdk`, never on Gode's apps or another package's internals, as `scripts/plugins.test.ts` asserts, because a plugin ships apart from the app, runs against versions of Gode it was not built with, and must build the way a plugin from any other publisher would.
- Pack every archive with `packPlugin` from `@gode/plugin-sdk/pack`, so releases and the host see the same layout and name for every publisher's plugins.
- Declare every setting, action and view in `page/` and every word in `i18n/`, and report state only as a `PluginStatus` or view data naming those words, because Gode draws a plugin's interface itself and never runs plugin code in a window.
- Write every word in each language Gode speaks, one `i18n/<locale>.json` each, by `../gode/apps/desktop/src/shared/i18n/AGENTS.md` and its language folders, and keep `scripts/plugins.test.ts` passing.
- Keep a plugin's code in `src/`, one module for each purpose with `src/main.ts` only connecting them, and its tests in `test/` mirroring `src/`, written with `@gode/plugin-sdk/test` and run by `gode-plugin test`, never with a test framework of the plugin's own, because the SDK checks what a plugin sends by Gode's own rules.
- Pin every file a plugin or its build downloads by URL and SHA-256, verify it before use, and never leave a partial file under its final name.
- Write what a person needs to diagnose a failure to the plugin's log with `log`, and never a secret or what the person said or typed, because people share logs to get help.
- Keep what a plugin downloads or keeps in `paths.data`, never in the read-only `paths.plugin`, let every call stand on its own because calls overlap, and stop the programs it started when Gode sends `SIGTERM`.
- Raise `minimumAppVersion` to the first Gode that has each capability the plugin uses.
- Raise a plugin's `version` for every change that ships, because Gode installs a version once and updates only to a newer one.
- Release with `pnpm release <id>` and upload the catalog with `pnpm catalog` only when the owner asks, because every installed copy offers the new version to its person within six hours.
