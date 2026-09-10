# Verification scope

The release remediation is tested without private accounts, public relay publication or executable content from the network.

## Recorded final gates (2026-09-10)

- Local runtime: Node 25.2.1, pnpm 8.15.0, installed Chromium; CI is configured for Node 22.12+ compatibility via Node 22 and the pinned pnpm version. The CI service itself was not run locally.
- Frozen-lockfile install, lint, Svelte-check (zero errors/warnings), 40 tests in 12 suites, build and eight production-artifact Chromium tests pass via `pnpm verify`.
- Domain coverage: 97.55% statements/lines, 100% functions, 87.57% branches in the final recorded run.
- Production artifact: one HTML file, approximately 315 KB (103 KB gzip); tests verify no external script/stylesheets or development signer fixture are included.
- Host: 88 focused tests pass; changed Svelte surfaces compile without warnings. The actual repo-tab route's focused browser test passes (4.6 seconds, mocked relay transport, fresh anonymous context).
- Helper visual checks: warm synthetic failure/resume preserves signed IDs; a fresh cold 390×844 detail view keeps the filename readable and horizontal overflow inside the asset table. The final cold check has no browser errors, only Vite connection debug messages. Helper browser sessions are closed.
- Explicit implementation formatting and both repositories' diff checks pass. Host tests emit third-party missing-sourcemap warnings; the pnpm 8 installer emits a Node 25 deprecation warning. Neither is a product failure or silently treated as a failed gate.

## Domain regressions

`pnpm test:coverage` includes signature tampering, outsider publishers, exact repository linkage, publisher namespaces, deterministic replacements, application revocation, spoofed/ambiguous runs, asset lineage, independent asset metadata, required APK fields, safe URLs, local-file mismatch, pinned signer changes, corrupted journals, partial retry, async disposal, cache authority, relay cursors/partial responses, unresolved assets and Markdown sanitization. Offline manifest generation tests actual shell URL expansion and permissions/kinds.

Coverage is for `src/lib/**/*.ts` implementation only, excluding types/test fixtures. Gates: 95% statements/lines/functions and 85% branches. Svelte markup/CSS is not passed off as instrumented unit code; component behavior has separate Chromium tests. The former blanket 95% scaffold gate incorrectly counted uninstrumented component/style/config lines.

## Widget browser fixture

`pnpm e2e` builds the widget, then fulfills its iframe navigation inside `test-host/` at `http://localhost:5179/test-host/` with that self-contained production HTML. It uses the repo-tab sandbox and mock postMessage responses with genuine synthetic Nostr signatures. HTTPS popup requests are fulfilled by the test browser, not sent to external services.

Checks: unauthorized releases hidden; addressable replacement; logout/clear; stale fallback response; subscription cleanup; sanitized notes; user-activated asset popup preserving iframe navigation; local hash mismatch/match and selection invalidation; a delayed earlier match cannot overwrite a newer mismatch after a metadata retry; one-run selection; fixed-event resume after a reload; incomplete discovery/retry; mobile table containment; production artifact excludes the test signer fixture. The fixture is not the Budabit host implementation.

The isolated `oc2-browser` warm/cold profiles are used separately for visual checks. Evidence remains in private session artifacts, not the repository. No personal browser is attached.

## Budabit integration

Host commit `c97928826` adds focused bridge/query/context/origin tests (88 tests across the selected suites), including delayed events beyond the former 500 ms cutoff, per-relay completion, known-ID completion, aborted/late queries, pinned scope, kinds, owned unsubscribe and accepted runtime origins. Changed host Svelte components compile without warnings.

The existing `repository-identity-integration.spec.ts` test **“the actual extension route preserves addresses and storage through rename and remount”** passes against the actual `/git/<naddr>/extensions/identity-review` surface on the correct full development stack. It uses mocked relays, an anonymous fixture widget and a fresh browser context. A session-private Playwright config avoids the host suite's unrelated artifact cleanup/global authentication setup. This validates the real route/bridge context and storage lifecycle, not live CDN redirects or production signer services.

## Not established by these checks

No live Nostr account signing or relay publication, APK/native certificate validation, reproducible builds, malware scanning, CDN redirect deployment, large executable downloads, or full Budabit build/E2E/PWA/offline audit. EOSE only reports a bounded relay response; trust policy still depends on the host's current repository authority and relay availability. Legacy releases without the required application link are intentionally hidden.

## Review reconciliation

| Original finding                                                 | Remediation and evidence                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outsider releases and repository/name heuristics                 | Independent signatures and exact owner/maintainer/application links; trust/context tests and attacker browser fixture.                                                                      |
| Spoofed pipeline actor/delegation and historical filename voting | Authenticated run signer, unambiguous publisher delegation, contradictory lineage rejection, explicit single-run selection; pipeline tests and creation flow.                               |
| Missing NIP-82 links/metadata                                    | Application coordinate, independent asset identity/version, filename/platform/APK fields retained and validated; builder/parser tests.                                                      |
| Signature confused with binary/native verification               | Bounded local-file hash checks and explicit caveats; mismatch and selection-invalidation browser regressions. Native signatures remain out of scope.                                        |
| Partial signing/publication and changed account                  | All-sign-before-publish, template verification, scoped journal, current-context checks and identical-ID retries; publication tests and reload/resume flow.                                  |
| Stale cache/addressable revisions                                | Canonical replacement keys, link revocation, reverified scoped cache without cached application authority; list-controller tests and replacement flow.                                      |
| Missed context/logout and late listeners                         | Reactive context/explicit clears, stale fallback guard and disposal-safe startup; lifecycle tests and delayed-response/logout browser checks.                                               |
| Silent truncated queries and unresolved assets                   | Per-relay EOSE/partial metadata, bounded cursors, no 500 ms first-event cutoff, unresolved IDs/retry; widget and host query/detail tests.                                                   |
| Denied unsubscribe and divergent repo-tab surface                | Manifest unsubscribe permission, owned cleanup tests, actual route context/readiness helpers and repo-tab integration test.                                                                 |
| Unsafe redirects/blocked external links                          | Exact origin/source policy and synchronized push destination; reviewed popup/download sandbox; host origin tests and intercepted Chromium popup flow. Live CDN redirect remains unverified. |
| Scaffold build/CI/tests/docs                                     | Svelte-check, production-artifact tests, real manifest CLI test, pinned supported runtimes/actions/branches and actual-contract documentation. No publishing workflow was executed.         |
