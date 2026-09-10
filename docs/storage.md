# Release widget storage

The host wire format is:

```ts
// Requests
{ key, repoScoped: true, expectedRepoAddress }                 // storage:get
{ key, repoScoped: true, expectedRepoAddress, data }           // storage:set
// Responses
{ status: 'ok', data }                                        // get; null when missing
{ status: 'ok' }                                              // set
{ error: '...' }                                              // failure
```

SDK 0.2.0 storage declarations use `value`; the Budabit runtime uses **`data`**. The widget's adapter deliberately follows runtime behavior. `storage:set` with `data:null` removes the scoped entry. Storage is local to the browser, not a relay or synchronization API.

- `verified-releases-v2`: at most 100 release events and roughly 500 KB, with exact repository address and a one-day timestamp bound. Signatures and current authority are checked on read; applications are always discovered live. Cache misses/errors are recoverable.
- `release-publication-v1:<publisher>`: fixed, fully signed batch plus acceptance progress, scoped to widget/repository/account. At most 50 assets plus application/release. Storage failure before initial publication prevents relay writes. Partial/unknown relay publication preserves the batch for retry. The host's total value limit is 1 MiB; oversized batches fail before publication.

Host keys include the exact repository coordinate, not the display name. Optional expected repository/account fields reject stale writes after a context switch. The journal is reverified when loaded and before every publication attempt, including same-session resume. Its embedded application, if present, is merged with current discovered revisions before linkage authorization. Incomplete discovery or a newer revocation blocks writes. Resume deliberately resends all IDs rather than trusting local ACK markers. Successful completion removes the journal.

An invalid journal is not silently deleted. The creation view offers **Retry recovery** and **Discard local recovery data**, followed by **Keep recovery data** / **Confirm discard**. Confirmed discard rechecks the active repository/account, removes only that journal key with pinned scope fields, and reloads pipelines. A failed removal keeps recovery available. Discard does not remove cached releases or anything from relays, and prevents retrying that batch's original signed IDs unless a separate copy exists.

These entries contain public metadata but are not encrypted. Do not store credentials or confidential release notes. Clearing browser storage loses resume state; it does not undo any already-published event.
