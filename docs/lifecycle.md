# Release widget lifecycle

`App.svelte` registers `widget:init`, `context:update`, `context:repoUpdate` and theme listeners before signaling readiness. A revision-guarded `context:getRepo` fallback recovers missed initial messages, including the viewer. Null clears are honored; account, repository and maintainer changes reset list/detail/create navigation. An empty maintainer array never grants arbitrary accounts publication rights.

The list controller registers its event handler synchronously, opens a host-owned subscription and performs bounded historical queries. Disposal removes listeners and timers immediately, aborts subsequent query pages, and closes subscriptions even if their creation response arrives after disposal. The host owns physical subscription cleanup; unsubscribe error payloads are reported rather than mistaken for success.

Cached releases never establish application authority. Live/query revisions use canonical addressable keys, not event IDs. New application revisions can revoke repository linkage. Data omitted from a completed live query is not kept indefinitely as authoritative cached history.

Detail and creation loaders ignore results after their view is disposed. Publication checks a pinned account/repo before each step. Leaving or changing the context stops subsequent work; already-running host signing/publishing may still complete. The saved signed batch is the recovery point, not an assumption of atomic publication.

The actual Budabit repo-tab uses readiness plus context updates, not a guaranteed `widget:mounted`/`widget:unmounting` sequence. Its bridge is detached/recreated when the widget identity, permissions, URL or repository changes. It resends init/context/theme after an accepted readiness message or first message from an accepted runtime origin.
