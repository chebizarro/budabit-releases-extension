# Releases widget manifest

`pnpm manifest:generate` uses the locked SDK CLI to generate unsigned kind `30033` metadata in `dist/widget/`:

- `d`: `budabit-releases`
- type: `tool`
- title: Releases
- slot: `repo-tab`, label Releases, path `releases`
- app URL: `WIDGET_APP_URL`, defaulting to `http://localhost:5173` for development
- permissions: `nostr:sign`, `nostr:publish`, `nostr:query`, `nostr:subscribe`, `nostr:unsubscribe`, `storage:get`, `storage:set`, `storage:compareAndSet`
- Nostr kinds: `32267`, `30063`, `3063`, `1063`, `5401`

Each permission/kind is emitted as an individual `permission`/`nostrKinds` tag. The launch `button` tag carries the app URL. Production URLs must be HTTPS and should use an origin separate from Budabit.

```sh
WIDGET_APP_URL=https://your-cdn.example/releases.html pnpm manifest:generate
```

Generation is offline and does not sign or publish. The offline regression test validates URL expansion and exact permissions/kinds against actual CLI output. Publishing the widget is distinct from publishing software-release metadata inside the widget. Both require an explicit user action.

On the supported host, declared write kinds constrain generic signing and publication. Do not assume that older Budabit versions enforce write-kind restrictions merely because the manifest declares them.
