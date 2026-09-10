# Releases host bridge contract

Messages are `{type: "request" | "response" | "event", id?, action, payload}`. Responses return their payload directly to the SDK. Errors may be `{error: string, code?: string}` rather than rejected promises; consumers must check both.

## Context and readiness

The repo-tab host sends `widget:init`, compatible `context:update` and flat `context:repoUpdate`. The widget registers handlers before `signalReady()` and also requests `context:getRepo` after 500 ms. A late fallback response cannot replace a newer pushed context.

`context:getRepo` returns:

```ts
{ status: "ok", repoContext: {
  pubkey, name, displayName, naddr, address, relays, maintainers, userPubkey
} }
```

`name` is the exact repository `d` tag, not display text. `address` is `30617:<pubkey>:<exact-d>`; `naddr` is a distinct encoded pointer. Flat updates use `repoPubkey`, `repoName`, `repoNaddr`, `repoAddress`, `repoRelays`, `maintainers`, `userPubkey`. `context:update` wraps that in `{repo, userPubkey, relays, contextId}`. Null repository/viewer values explicitly clear state. The owner is always included in the normalized maintainer set.

`widget:init.capabilities.features` exposes `nostr.queryCompleteness`, `nostr.expectedSigner` and `nostr.declaredWriteKinds`. Theme arrives through `widget:init` and `widget:themeChanged`. Do not depend on `widget:mounted`/`widget:unmounting` for repo-tab cleanup.

## Nostr reads

`nostr:query`: request `{relays, filter}`, response `{status:"ok", events, complete, completedRelays, failedRelays, timedOutRelays}`. A successful response can still be **partial**. The host observes per-relay EOSE (or fulfillment of every exact requested event ID), bounds work, aborts it at closeout and ignores late events. It does not resolve 500 ms after the first event anymore. A settled Welshman loader alone is not completion evidence.

Limits: eight relays/request and 500 events/filter on the host. The widget pages at 100 events, at most five pages/relay, with inclusive `until`. A full shared-second boundary is unresolved, not skipped. Incoming event signatures and filters are checked independently by the widget even if a host trusts particular relays.

`nostr:subscribe`: request `{relays, filter}`, response `{status:"ok", subscriptionId}`. The **host-generated** ID is authoritative. Events arrive as `nostr:subscription:event` with `{subscriptionId,event}`; `nostr:eose` is per relay. The widget buffers events arriving before the subscription response and ignores unrelated IDs. `nostr:unsubscribe` requires its own permission and `{subscriptionId}`. Whole-iframe detach also cleans host subscriptions. Limits: ten/widget, eight relays/subscription.

## Signing and publication

`nostr:sign` takes an unsigned template plus `{expectedPubkey, expectedRepoAddress}`. The host checks account/repo/maintainer scope and declared write kinds, then checks scope again after the interactive signer returns. The widget independently verifies the returned event's signature, publisher and exact template.

`nostr:publish` takes `{event: signedEvent, relays, expectedPubkey, expectedRepoAddress}`. Pinned publication requires an already-signed event. Response: `{status:"ok", result:{eventId, successCount, ...}}`; zero accepted relays is failure. Do not wrap that payload a second time or infer success from an event ID alone.

The widget's SDK timeout is 120 seconds to accommodate interactive signers. A timeout is not cancellation of an already-running host operation. The signed publication journal makes uncertain relay publication retryable without re-signing.

Declared `nostrKinds` now constrain generic signing/publication when present. Queries/subscriptions additionally retain the host's existing NIP-100 baseline kinds; they are not a universal profile-read API. Older hosts did not constrain write kinds this way.

## Storage and iframe policy

Use `data`, **not `value`**, for host storage. SDK 0.2.0 declarations drift from this runtime wire format. Requests include `repoScoped:true` and `expectedRepoAddress`; journals also include `expectedPubkey`. See [storage](storage.md).

The repo-tab sandbox is `allow-scripts allow-same-origin allow-forms allow-popups allow-downloads`: no top navigation or popup sandbox escape. Serve widgets from another origin. Host messages require the expected iframe window and exact origin. The only special redirect is `https://blossom.primal.net` → `https://r2a.primal.net`; arbitrary `primal.net` substrings/suffixes are rejected. Accepted runtime origins are used for subsequent pushed events.
