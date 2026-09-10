# Release widget architecture

```text
Budabit repo-tab + bridge → SDK postMessage transport → Svelte widget
       │                                             │
       ├─ account signer                             ├─ context.ts: exact identities/viewer
       ├─ Welshman relay infrastructure               ├─ trust.ts: signatures/authorization/replacements
       └─ repo-scoped local storage                   ├─ query.ts: bounded complete/partial discovery
                                                     ├─ list-controller.ts: subscription/cache lifecycle
                                                     ├─ pipelines.ts: authenticated run/artifact selection
                                                     ├─ publication.ts: pinned signing + signed journal
                                                     ├─ binary.ts: safe URLs/local-file SHA-256
                                                     └─ markdown.ts: sanitized release notes
```

The iframe never opens relay WebSockets or imports Welshman. It uses `nostr-tools` for cryptographic/event checks and `@noble/hashes` for incremental local-file hashing. `budabit-sdk@0.2.0` supplies transport and manifest tools; local adapters correct its runtime type drift without rewriting the SDK.

Kinds: application `32267`, release `30063`, asset `3063`, pipeline run `5401`, legacy build artifact `1063`, widget manifest `30033`. `releases.ts` parses/builds NIP-82 metadata and provides bounded data-loading/formatting helpers.

Each view has an explicit trust/loading lifecycle. Discovery is separate from authorization; a valid signature is not sufficient for repository membership. Publication freezes inputs, validates/signs every template, saves signed IDs and only then sends events. Partial success is recoverable, not atomic.

The production Vite build is one HTML file. `test-host/` is a separate development-only entrypoint used by focused Chromium tests; it uses synthetic keys and a memory/sessionStorage wire fixture, never real relay writes.
