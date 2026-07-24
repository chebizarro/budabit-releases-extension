<script lang="ts">
  import type { NostrEvent, RepoContext, WidgetBridge } from 'budabit-sdk';
  import type { SoftwareApplication } from '../types.js';
  import { RELEASE_KIND } from '../types.js';
  import { parseReleaseListItem, formatDate, loadRepoApps } from '../releases.js';
  import { getRelays } from '../releases.js';

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

    // Two-phase: discover apps linked to this repo, then subscribe to their releases.
    (async () => {
      try {
        // Phase 1: find kind 32267 applications linked to this repo
        const discovered = await loadRepoApps(bridge, repo);
        apps = discovered;

        // If no apps exist, also try querying releases authored by the repo maintainers
        // (covers first-time use before an app event exists)
        const appIds = discovered.map((a) => a.appId).filter(Boolean);
        const maintainers = repo.maintainers ?? [];
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

        // Phase 2: subscribe to releases matching the filter
        offEvent = bridge.onEvent('nostr:subscription:event', (payload) => {
          if (payload.subscriptionId !== hostSubscriptionId) return;
          releaseEvents = new Map(releaseEvents).set(payload.event.id, payload.event);
        });

        offEose = bridge.onEvent('nostr:eose', (payload) => {
          if (payload.subscriptionId !== hostSubscriptionId) return;
          loading = false;
        });

        subscription = await bridge.subscribe({
          subscriptionId: requestedSubscriptionId,
          relays,
          filter,
        });
        hostSubscriptionId = subscription.subscriptionId;

        if (disposed) {
          await subscription.unsubscribe().catch(() => {});
          subscription = null;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
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
  {:else}
    <ul class="releases">
      {#each sortedReleases as event (event.id)}
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
