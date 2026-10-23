# Gode official plugins

Gode's own plugins. A plugin adds a capability that Gode does not ship, such as voice input, and only the people who want it install it from Settings › Plugins. Plugins are a separate layer from integrations: an integration is a service built into Gode that Gode signs in to, while a plugin is a separate process that Gode downloads, runs, updates and can remove.

Each folder in `plugins/` is a workspace package that reaches Gode only through `@gode/plugin-sdk`, so it is written, built, signed and released the way a plugin from any other publisher is. The SDK's README in the Gode repository (`packages/plugin-sdk/README.md`) is the guide to writing and publishing a plugin; this file covers what is particular to Gode's own.

| Plugin | What it offers |
| --- | --- |
| [`voice-input`](plugins/voice-input) | Dictation, recognized on this computer with Qwen3-ASR or by a server the person chooses. |
| [`typescript`](plugins/typescript) | A language server for TypeScript and JavaScript. |
| [`vue`](plugins/vue) | A language server for Vue. |
| [`svelte`](plugins/svelte) | A language server for Svelte. |
| [`astro`](plugins/astro) | A language server for Astro. |
| [`python`](plugins/python) | A language server for Python. |
| [`rust`](plugins/rust) | A language server for Rust. |
| [`jujutsu`](plugins/jujutsu) | Source control for Jujutsu repositories. |

## Setting up

Until `@gode/plugin-sdk` is published, the plugins link it and `@gode/format` from a checkout of the Gode repository beside this one, at `../gode`, whose dependencies must be installed:

```sh
pnpm --dir ../gode install
pnpm install
```

## Commands

```sh
pnpm test                                    # every plugin's tests and the release scripts' tests
pnpm typecheck
pnpm lint                                    # oxlint and oxfmt; pnpm lint:fix applies their fixes
pnpm --dir plugins/<id> build                # every platform
pnpm --dir plugins/<id> build darwin-arm64   # one platform
```

The language plugins build with `gode-plugin build`. Their `build.ts` stages the server into the SDK's archive layout, and `scripts/plugins.test.ts` checks every plugin's manifest, translations and package boundaries.

## Adding a capability

A capability is a change to Gode itself, made before any plugin offers it. Add it to `pluginCapabilities` with its methods in `CapabilityMethods`, `capabilityOfMethod` and `capabilityResultSchemas` in the SDK's `src/contract.ts`, and build its commands and controls in the desktop app, shown only while a ready plugin offers it. Raise `minimumAppVersion` in the plugins that use it to the first Gode that has it.

## Trying plugins

To try plugins in a development build of Gode, gather their archives into a local feed and point Gode at it:

```sh
pnpm index                                   # every archive in plugins/*/out → out/plugins
python3 -m http.server 41493 --bind 127.0.0.1 --directory out/plugins
GODE_PLUGINS_URL=http://127.0.0.1:41493 pnpm --dir ../gode dev
```

`pnpm index` writes a catalog and each plugin's `releases.json`, signed with a key it makes for that feed alone. `GODE_PLUGINS_URL` works only in development builds and tests.

## Releasing

Each plugin releases on its own, without a release of Gode and without touching the other plugins:

```sh
pnpm --dir plugins/<id> build
pnpm release <id>
```

`pnpm release` signs the new version with Gode's plugin key from the Keychain item `gode-plugin-signing`, adds it to the `releases.json` already on the feed and uploads the archives, then that file, to `plugins/gode/<id>/` on the update feed, which every release channel shares. It uploads with Wrangler, signed in to the Cloudflare account in `wrangler.jsonc`. Installed copies update within six hours.

`catalog.json` is the catalog Gode serves as `plugins/index.json`: one entry per listed plugin, Gode's and other publishers', each with the address of its `releases.json` and its public key. `pnpm catalog` uploads it after a change, such as listing a reviewed plugin from another publisher or replacing a publisher's key.
