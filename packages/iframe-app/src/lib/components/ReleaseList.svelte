<script lang="ts">
  import type { NostrEvent, RepoContext, WidgetBridge } from 'budabit-sdk';
  import type { SoftwareApplication } from '../types.js';
  import { RELEASE_KIND } from '../types.js';
  import { parseReleaseListItem, formatDate, loadRepoApps, platformLabel } from '../releases.js';
  import { getRelays, queryEvents, loadCachedReleaseState, saveCachedReleaseState } from '../releases.js';

  interface Props {
    bridge: WidgetBridge;
    repo: RepoContext;
    isMaintainer: boolean;
    onViewRelease: (event: NostrEvent) => void;
    onCreateRelease: (apps: SoftwareApplication[]) => void;
  }

  let { bridge, repo, isMaintainer, onViewRelease, onCreateRelease }: Props = $props();

  // keyed by event id for deduplication
  let releaseEvents = $state(new Map<string, NostrEvent>());
  let apps = $state<SoftwareApplication[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const sortedReleases = $derived(
    [...releaseEvents.values()].sort((a, b) => b.created_at - a.created_at)
  );

  // ── Filtering + pagination ────────────────────────────────────────────────
  const PAGE_SIZE = 20;
  let versionFilter = $state('');
  let platformFilter = $state('all');
  let dateFilter = $state('all'); // 'all' | days as string
  let page = $state(1);

  function eventVersion(event: NostrEvent): string {
    return (
      event.tags.find((t) => t[0] === 'version')?.[1] ??
      event.tags.find((t) => t[0] === 'd')?.[1]?.split('@').pop() ??
      ''
    );
  }

  function eventPlatforms(event: NostrEvent): string[] {
    return event.tags.filter((t) => t[0] === 'f').map((t) => t[1]).filter(Boolean);
  }

  const availablePlatforms = $derived(
    [...new Set([...releaseEvents.values()].flatMap(eventPlatforms))].sort()
  );

  const filteredReleases = $derived.by(() => {
    const v = versionFilter.trim().toLowerCase();
    const cutoff =
      dateFilter === 'all' ? 0 : Math.floor(Date.now() / 1000) - Number(dateFilter) * 86400;
    return sortedReleases.filter((event) => {
      if (cutoff && event.created_at < cutoff) return false;
      if (v && !eventVersion(event).toLowerCase().includes(v)) return false;
      if (platformFilter !== 'all' && !eventPlatforms(event).includes(platformFilter)) return false;
      return true;
    });
  });

  const totalPages = $derived(Math.max(1, Math.ceil(filteredReleases.length / PAGE_SIZE)));
  const currentPage = $derived(Math.min(page, totalPages));
  const pagedReleases = $derived(
    filteredReleases.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  );
  const hasActiveFilters = $derived(
    versionFilter.trim() !== '' || platformFilter !== 'all' || dateFilter !== 'all'
  );

  function resetPage() {
    page = 1;
  }

  function clearFilters() {
    versionFilter = '';
    platformFilter = 'all';
    dateFilter = 'all';
    page = 1;
  }

  $effect(() => {
    if (!bridge || !repo) return;

    loading = true;
    error = null;
    releaseEvents = new Map();
    apps = [];

    const relays = getRelays(repo.repoRelays);
    const requestedSubscriptionId = 'releases-list-' + Math.random().toString(36).slice(2);
    let hostSubscriptionId: string | null = null;
    let subscription: Awaited<ReturnType<WidgetBridge['subscribe']>> | null = null;
    let disposed = false;
    let offEvent: () => void = () => {};
    let offEose: () => void = () => {};
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleCacheSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void saveCachedReleaseState(bridge, apps, [...releaseEvents.values()]);
      }, 1000);
    };

    // Stale-while-revalidate: render the cached list instantly while the live
    // discovery + subscription below refreshes it in the background.
    (async () => {
      const cached = await loadCachedReleaseState(bridge);
      if (disposed || !cached || cached.events.length === 0) return;
      // Merge under live data: anything already received from the
      // subscription wins over the cache.
      releaseEvents = new Map([
        ...cached.events.map((e) => [e.id, e] as const),
        ...releaseEvents,
      ]);
      if (apps.length === 0 && cached.apps.length > 0) apps = cached.apps;
      loading = false;
    })();

    // Two-phase: discover apps linked to this repo, then subscribe to their releases.
    (async () => {
      try {
        // Phase 1: find kind 32267 applications linked to this repo
        const discovered = await loadRepoApps(bridge, repo);
        apps = discovered;

        // If no apps exist, also try querying releases authored by the repo maintainers
        // (covers first-time use before an app event exists)
        const appIds = discovered.map((a) => a.appId).filter(Boolean);
        // Spread to plain arrays: `repo` is a reactive $state proxy, and proxies
        // can't be structured-cloned through postMessage.
        const maintainers = [...(repo.maintainers ?? [])];
        const repoPubkey = repo.repoPubkey;

        // Build subscription filter
        let filter: Record<string, unknown>;
        if (appIds.length > 0) {
          // NIP-82 correct: filter by app identifiers
          filter = { kinds: [RELEASE_KIND], '#i': appIds };
        } else if (maintainers.length > 0) {
          // Fallback: releases by maintainers
          filter = { kinds: [RELEASE_KIND], authors: maintainers };
        } else if (repoPubkey) {
          // Last resort: releases by repo owner
          filter = { kinds: [RELEASE_KIND], authors: [repoPubkey] };
        } else {
          loading = false;
          return;
        }

        // Phase 2a: one-shot backfill of stored releases. The host's query
        // path runs at normal priority and is not subject to the background
        // subscription scheduler, so stored events arrive reliably even when
        // relays are saturated.
        queryEvents(bridge, relays, filter)
          .then((events) => {
            if (disposed) return;
            if (events.length > 0) {
              const next = new Map(releaseEvents);
              for (const event of events) next.set(event.id, event);
              releaseEvents = next;
              scheduleCacheSave();
            }
            loading = false;
          })
          .catch(() => {
            // Subscription below still covers us.
          });

        // Phase 2b: subscribe for live updates matching the filter.
        // The host can start delivering events before the subscribe response
        // arrives (fast relays / host-cached events), so buffer anything that
        // shows up before we know our subscription id — dropped events are
        // never re-delivered (host-side dedup).
        let pendingEvents: {subscriptionId: string; event: NostrEvent}[] | null = [];
        const applyEvent = (event: NostrEvent) => {
          releaseEvents = new Map(releaseEvents).set(event.id, event);
          scheduleCacheSave();
        };
        offEvent = bridge.onEvent('nostr:subscription:event', (payload) => {
          if (hostSubscriptionId === null) {
            pendingEvents?.push(payload);
            return;
          }
          if (payload.subscriptionId !== hostSubscriptionId) return;
          applyEvent(payload.event);
        });

        offEose = bridge.onEvent('nostr:eose', (payload) => {
          if (payload.subscriptionId !== hostSubscriptionId) return;
          loading = false;
          scheduleCacheSave();
        });

        subscription = await bridge.subscribe({
          subscriptionId: requestedSubscriptionId,
          relays,
          filter,
        });
        hostSubscriptionId = subscription.subscriptionId;

        // Flush events that arrived while the subscribe response was in flight.
        for (const pending of pendingEvents ?? []) {
          if (pending.subscriptionId === hostSubscriptionId) applyEvent(pending.event);
        }
        pendingEvents = null;

        // Older hosts never send nostr:eose — don't leave the spinner up for
        // the full 15s safety timeout once the subscription is live.
        setTimeout(() => {
          if (!disposed) loading = false;
        }, 3000);

        if (disposed) {
          await subscription.unsubscribe().catch(() => {});
          subscription = null;
        }
      } catch (err) {
        // Keep showing cached data if we have it; only surface the error
        // when there is nothing else to render.
        if (releaseEvents.size === 0) {
          error = err instanceof Error ? err.message : String(err);
        }
        loading = false;
      }
    })();

    // Safety: mark done after 15s even if no EOSE
    const timer = setTimeout(() => {
      loading = false;
    }, 15000);

    return () => {
      disposed = true;
      clearTimeout(timer);
      if (saveTimer) clearTimeout(saveTimer);
      offEvent();
      offEose();
      void subscription?.unsubscribe().catch(() => {});
      subscription = null;
    };
  });

  function channelBadge(event: NostrEvent): string {
    const c = event.tags.find((t) => t[0] === 'c')?.[1];
    return c && c !== 'main' ? c : '';
  }
</script>

<div class="release-list">
  <div class="list-header">
    <h2>Releases</h2>
    {#if isMaintainer}
      <button class="btn-primary" onclick={() => onCreateRelease(apps)}>New Release</button>
    {/if}
  </div>

  {#if sortedReleases.length > 0}
    <div class="filter-bar">
      <input
        class="filter-input"
        type="search"
        placeholder="Filter version…"
        bind:value={versionFilter}
        oninput={resetPage}
      />
      {#if availablePlatforms.length > 0}
        <select class="filter-select" bind:value={platformFilter} onchange={resetPage}>
          <option value="all">All platforms</option>
          {#each availablePlatforms as platform (platform)}
            <option value={platform}>{platformLabel([platform])}</option>
          {/each}
        </select>
      {/if}
      <select class="filter-select" bind:value={dateFilter} onchange={resetPage}>
        <option value="all">Any time</option>
        <option value="30">Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="365">Last year</option>
      </select>
      {#if hasActiveFilters}
        <button class="btn-clear" onclick={clearFilters}>Clear</button>
        <span class="filter-count">
          {filteredReleases.length} of {sortedReleases.length}
        </span>
      {/if}
    </div>
  {/if}

  {#if loading}
    <div class="state-message">Loading releases…</div>
  {:else if error}
    <div class="state-error">Failed to load releases: {error}</div>
  {:else if sortedReleases.length === 0}
    <div class="empty-state">
      <p class="empty-title">No releases yet</p>
      {#if isMaintainer}
        <p class="empty-hint">Create the first release from your pipeline builds.</p>
        <button class="btn-primary" onclick={() => onCreateRelease(apps)}>Create Release</button>
      {:else}
        <p class="empty-hint">No releases have been published for this repository.</p>
      {/if}
    </div>
  {:else if filteredReleases.length === 0}
    <div class="empty-state">
      <p class="empty-title">No matching releases</p>
      <p class="empty-hint">No releases match the current filters.</p>
      <button class="btn-clear" onclick={clearFilters}>Clear filters</button>
    </div>
  {:else}
    <ul class="releases">
      {#each pagedReleases as event (event.id)}
        {@const item = parseReleaseListItem(event)}
        {@const channel = channelBadge(event)}
        <li class="release-card">
          <button class="release-card-btn" onclick={() => onViewRelease(event)} type="button">
            <div class="release-tag">
              <span class="tag-badge">{item.version}</span>
              {#if channel}
                <span class="channel-badge">{channel}</span>
              {/if}
            </div>
            <div class="release-meta">
              <span class="meta-date">{formatDate(item.createdAt)}</span>
              <span class="meta-sep">·</span>
              <span class="meta-count">{item.assetCount} asset{item.assetCount !== 1 ? 's' : ''}</span>
              {#if item.appId}
                <span class="meta-sep">·</span>
                <span class="meta-app">{item.appId}</span>
              {/if}
            </div>
            {#if event.content}
              <p class="release-notes-preview">{event.content.split('\n')[0]}</p>
            {/if}
          </button>
        </li>
      {/each}
    </ul>

    {#if totalPages > 1}
      <div class="pagination">
        <button
          class="btn-page"
          disabled={currentPage <= 1}
          onclick={() => (page = currentPage - 1)}>← Prev</button>
        <span class="page-indicator">Page {currentPage} of {totalPages}</span>
        <button
          class="btn-page"
          disabled={currentPage >= totalPages}
          onclick={() => (page = currentPage + 1)}>Next →</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .release-list {
    padding: 1.25rem;
  }

  .list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--ext-text);
  }

  .btn-primary {
    padding: 0.4rem 0.9rem;
    background: var(--ext-accent);
    color: var(--ext-accent-text);
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-primary:hover {
    background: var(--ext-accent-hover);
  }

  .filter-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .filter-input,
  .filter-select {
    padding: 0.35rem 0.6rem;
    background: var(--ext-surface);
    color: var(--ext-text);
    border: 1px solid var(--ext-border);
    border-radius: 6px;
    font-size: 0.8rem;
    font-family: inherit;
  }

  .filter-input {
    flex: 1 1 140px;
    min-width: 120px;
  }

  .filter-input:focus,
  .filter-select:focus {
    outline: none;
    border-color: var(--ext-accent);
  }

  .btn-clear {
    padding: 0.35rem 0.6rem;
    background: none;
    color: var(--ext-accent);
    border: 1px solid var(--ext-border);
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .btn-clear:hover {
    border-color: var(--ext-accent);
    background: var(--ext-accent-soft-2);
  }

  .filter-count {
    font-size: 0.75rem;
    color: var(--ext-text-muted);
    white-space: nowrap;
  }

  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .btn-page {
    padding: 0.35rem 0.75rem;
    background: var(--ext-surface);
    color: var(--ext-accent);
    border: 1px solid var(--ext-border);
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .btn-page:hover:not(:disabled) {
    border-color: var(--ext-accent);
    background: var(--ext-accent-soft-2);
  }

  .btn-page:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .page-indicator {
    font-size: 0.8rem;
    color: var(--ext-text-muted);
  }

  .state-message,
  .state-error {
    padding: 1.5rem;
    text-align: center;
    color: var(--ext-text-muted);
    font-size: 0.9rem;
  }

  .state-error {
    color: var(--ext-danger-text);
    background: var(--ext-danger-bg);
    border-radius: 8px;
  }

  .empty-state {
    padding: 2.5rem 1rem;
    text-align: center;
  }

  .empty-title {
    margin: 0 0 0.4rem;
    font-size: 1rem;
    font-weight: 600;
    color: var(--ext-text);
  }

  .empty-hint {
    margin: 0 0 1.25rem;
    color: var(--ext-text-muted);
    font-size: 0.875rem;
  }

  .releases {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .release-card {
    list-style: none;
  }

  .release-card-btn {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--ext-surface);
    border: 1px solid var(--ext-border);
    border-radius: 8px;
    padding: 0.9rem 1rem;
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .release-card-btn:hover {
    border-color: var(--ext-accent);
    box-shadow: 0 1px 4px rgba(26, 115, 232, 0.15);
  }

  .release-tag {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.3rem;
  }

  .tag-badge {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    background: var(--ext-accent-soft);
    color: var(--ext-accent-hover);
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    font-family: monospace;
  }

  .channel-badge {
    display: inline-block;
    padding: 0.12rem 0.45rem;
    background: var(--ext-warning-bg);
    color: var(--ext-warning-text);
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .release-meta {
    font-size: 0.8rem;
    color: var(--ext-text-muted);
    margin-bottom: 0.25rem;
  }

  .meta-sep {
    margin: 0 0.3rem;
  }

  .meta-app {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--ext-text-faint);
  }

  .release-notes-preview {
    margin: 0;
    font-size: 0.85rem;
    color: var(--ext-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
