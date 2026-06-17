<script lang="ts">
  import type { WidgetBridge, RepoContext } from 'budabit-sdk';
  import type { NostrEvent } from '../types.js';
  import { parseReleaseListItem, formatDate } from '../releases.js';
  import { getRelays, openSubscription, closeSubscription, tagValue } from '../bridge.js';

  interface Props {
    bridge: WidgetBridge;
    repo: RepoContext;
    isMaintainer: boolean;
    onViewRelease: (event: NostrEvent) => void;
    onCreateRelease: () => void;
  }

  let { bridge, repo, isMaintainer, onViewRelease, onCreateRelease }: Props = $props();

  // keyed by event id for deduplication
  let releaseEvents = $state(new Map<string, NostrEvent>());
  let loading = $state(true);
  let error = $state<string | null>(null);

  const sortedReleases = $derived(
    [...releaseEvents.values()].sort((a, b) => b.created_at - a.created_at)
  );

  $effect(() => {
    if (!bridge || !repo?.repoNaddr) return;

    loading = true;
    error = null;
    releaseEvents = new Map();

    const subId = 'releases-list-' + Math.random().toString(36).slice(2);
    const relays = getRelays(repo.repoRelays);

    // Register event handlers synchronously before opening subscription
    const offEvent = bridge.onEvent('nostr:event', (payload: unknown) => {
      const p = payload as { subscriptionId: string; event: NostrEvent } | null;
      if (!p || p.subscriptionId !== subId) return;
      releaseEvents = new Map(releaseEvents).set(p.event.id, p.event);
    });

    const offEose = bridge.onEvent('nostr:eose', (payload: unknown) => {
      const p = payload as { subscriptionId: string } | null;
      if (!p || p.subscriptionId !== subId) return;
      loading = false;
    });

    openSubscription(bridge, relays, { kinds: [30063], '#a': [repo.repoNaddr] }, subId).catch(
      (err) => {
        error = err instanceof Error ? err.message : String(err);
        loading = false;
      }
    );

    // Safety: mark done after 15s even if no EOSE
    const timer = setTimeout(() => {
      loading = false;
    }, 15000);

    return () => {
      clearTimeout(timer);
      offEvent();
      offEose();
      closeSubscription(bridge, subId);
    };
  });
</script>

<div class="release-list">
  <div class="list-header">
    <h2>Releases</h2>
    {#if isMaintainer}
      <button class="btn-primary" onclick={onCreateRelease}>New Release</button>
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
        <button class="btn-primary" onclick={onCreateRelease}>Create Release</button>
      {:else}
        <p class="empty-hint">No releases have been published for this repository.</p>
      {/if}
    </div>
  {:else}
    <ul class="releases">
      {#each sortedReleases as event (event.id)}
        {@const item = parseReleaseListItem(event)}
        <li class="release-card" onclick={() => onViewRelease(event)} role="button" tabindex="0"
          onkeydown={(e) => e.key === 'Enter' && onViewRelease(event)}>
          <div class="release-tag">
            <span class="tag-badge">{item.version}</span>
          </div>
          <div class="release-meta">
            <span class="meta-date">{formatDate(item.createdAt)}</span>
            <span class="meta-sep">·</span>
            <span class="meta-count">{item.artifactCount} artifact{item.artifactCount !== 1 ? 's' : ''}</span>
          </div>
          {#if event.content}
            <p class="release-notes-preview">{event.content.split('\n')[0]}</p>
          {/if}
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
    color: #111;
  }

  .btn-primary {
    padding: 0.4rem 0.9rem;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-primary:hover {
    background: #1558c0;
  }

  .state-message,
  .state-error {
    padding: 1.5rem;
    text-align: center;
    color: #666;
    font-size: 0.9rem;
  }

  .state-error {
    color: #c62828;
    background: #fce4e4;
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
    color: #333;
  }

  .empty-hint {
    margin: 0 0 1.25rem;
    color: #666;
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
    background: #fff;
    border: 1px solid #e8e8e8;
    border-radius: 8px;
    padding: 0.9rem 1rem;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .release-card:hover {
    border-color: #1a73e8;
    box-shadow: 0 1px 4px rgba(26, 115, 232, 0.15);
  }

  .release-tag {
    margin-bottom: 0.3rem;
  }

  .tag-badge {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    background: #e8f0fe;
    color: #1558c0;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    font-family: monospace;
  }

  .release-meta {
    font-size: 0.8rem;
    color: #888;
    margin-bottom: 0.25rem;
  }

  .meta-sep {
    margin: 0 0.3rem;
  }

  .release-notes-preview {
    margin: 0;
    font-size: 0.85rem;
    color: #555;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
