<script lang="ts">
  import { createWidgetBridge, type WidgetBridge, type WidgetInitPayload, type RepoContext } from 'budabit-sdk';
  import type { NostrEvent } from './lib/types.js';
  import ReleaseList from './lib/components/ReleaseList.svelte';
  import ReleaseDetail from './lib/components/ReleaseDetail.svelte';
  import CreateRelease from './lib/components/CreateRelease.svelte';

  // ── Bridge + context ──────────────────────────────────────────────────────
  let bridge = $state<WidgetBridge | null>(null);
  let initPayload = $state<WidgetInitPayload | null>(null);
  let repoContext = $state<RepoContext | null>(null);

  // ── View routing ──────────────────────────────────────────────────────────
  type View = 'list' | 'detail' | 'create';
  let view = $state<View>('list');
  let selectedEvent = $state<NostrEvent | null>(null);

  // ── Derived helpers ───────────────────────────────────────────────────────
  const userPubkey = $derived(initPayload?.pubkey ?? '');

  const trustedMaintainers = $derived(
    (repoContext as (RepoContext & { maintainers?: string[] }) | null)?.maintainers ?? []
  );

  const isMaintainer = $derived(
    userPubkey.length > 0 &&
    (trustedMaintainers.length === 0 || trustedMaintainers.includes(userPubkey))
  );

  // ── Bridge lifecycle ──────────────────────────────────────────────────────
  $effect(() => {
    const b = createWidgetBridge({
      targetWindow: window.parent,
      targetOrigin: '*',
      timeoutMs: 15000,
    });

    bridge = b;

    const offInit = b.onEvent('widget:init', (payload) => {
      initPayload = payload as WidgetInitPayload;
    });

    const offRepo = b.onEvent('context:repoUpdate', (ctx) => {
      repoContext = ctx as RepoContext;
    });

    b.signalReady();

    return () => {
      offInit();
      offRepo();
      b.destroy();
      bridge = null;
    };
  });

  // ── Navigation handlers ───────────────────────────────────────────────────
  function handleViewRelease(event: NostrEvent) {
    selectedEvent = event;
    view = 'detail';
  }

  function handleCreateRelease() {
    view = 'create';
  }

  function handleBack() {
    view = 'list';
    selectedEvent = null;
  }

  function handleCreateSuccess() {
    view = 'list';
    selectedEvent = null;
  }
</script>

<div class="app">
  {#if !bridge}
    <div class="initializing">Initializing…</div>
  {:else if !repoContext}
    <div class="no-context">
      <p>Waiting for repository context…</p>
      <p class="hint">This extension works inside a Flotilla git repository tab.</p>
    </div>
  {:else if view === 'detail' && selectedEvent}
    <ReleaseDetail
      {bridge}
      repo={repoContext}
      releaseEvent={selectedEvent}
      onBack={handleBack}
    />
  {:else if view === 'create' && isMaintainer}
    <CreateRelease
      {bridge}
      repo={repoContext}
      {trustedMaintainers}
      onSuccess={handleCreateSuccess}
      onCancel={handleBack}
    />
  {:else}
    <ReleaseList
      {bridge}
      repo={repoContext}
      {isMaintainer}
      onViewRelease={handleViewRelease}
      onCreateRelease={handleCreateRelease}
    />
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell,
      sans-serif;
    background: #fff;
    font-size: 14px;
    color: #111;
  }

  .app {
    min-height: 100vh;
  }

  .initializing,
  .no-context {
    padding: 2rem;
    text-align: center;
    color: #888;
    font-size: 0.9rem;
  }

  .no-context p {
    margin: 0 0 0.5rem;
  }

  .hint {
    color: #aaa;
    font-size: 0.8rem;
  }
</style>
