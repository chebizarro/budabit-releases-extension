<script lang="ts">
  import { createWidgetBridge, type WidgetBridge, type WidgetInitPayload, type RepoContext } from 'budabit-sdk';
  import type { NostrEvent, SoftwareApplication } from './lib/types.js';
  import ReleaseList from './lib/components/ReleaseList.svelte';
  import ReleaseDetail from './lib/components/ReleaseDetail.svelte';
  import CreateRelease from './lib/components/CreateRelease.svelte';

  // ── Bridge + context ──────────────────────────────────────────────────────
  let bridge = $state<WidgetBridge | null>(null);
  let initPayload = $state<WidgetInitPayload | null>(null);
  let repoContext = $state<RepoContext | null>(null);
  let debugLog = $state<string[]>([]);

  function dbg(msg: string) {
    console.log(`[releases] ${msg}`);
    debugLog = [...debugLog, `${new Date().toISOString().slice(11,23)} ${msg}`];
  }

  // ── View routing ──────────────────────────────────────────────────────────
  type View = 'list' | 'detail' | 'create';
  let view = $state<View>('list');
  let selectedEvent = $state<NostrEvent | null>(null);
  let discoveredApps = $state<SoftwareApplication[]>([]);

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

  /**
   * Normalize context from any host shape into our flat RepoContext.
   * The host sends different field names depending on the message:
   *   - context:repoUpdate → { repoPubkey, repoName, repoNaddr, repoRelays, maintainers }
   *   - context:getRepo    → { pubkey, name, naddr, relays, address }
   *   - context:update     → { repo: { repoPubkey, ... }, userPubkey, relays }
   */
  function normalizeRepoContext(input: any): RepoContext | null {
    if (!input || typeof input !== 'object') return null;
    // Already in the expected flat shape (context:repoUpdate)
    if (input.repoPubkey || input.repoNaddr) return input as RepoContext;
    // context:getRepo shape (pubkey, name, naddr, relays)
    if (input.pubkey && input.name) {
      return {
        repoPubkey: input.pubkey,
        repoName: input.name,
        repoNaddr: input.naddr ?? '',
        repoRelays: input.relays ?? [],
        maintainers: input.maintainers ?? [],
      } as RepoContext;
    }
    return null;
  }

  /**
   * Actively request repo context from the host via context:getRepo.
   * This is the reliable fallback when the host's push events are lost
   * due to a timing race (events fire before iframe listeners are ready).
   */
  async function fetchRepoContext(b: WidgetBridge): Promise<RepoContext | null> {
    try {
      dbg('fallback: requesting context:getRepo…');
      const res: any = await b.request('context:getRepo', {});
      dbg(`fallback: got response: ${JSON.stringify(res).slice(0, 200)}`);
      if (res?.status === 'ok' && res.repoContext) {
        const normalized = normalizeRepoContext(res.repoContext);
        dbg(`fallback: normalized to ${JSON.stringify(normalized).slice(0, 200)}`);
        return normalized;
      }
      dbg(`fallback: response did not match — status=${res?.status}, hasRepoContext=${!!res?.repoContext}, hasRepo=${!!res?.repo}`);
      return null;
    } catch (err) {
      dbg(`fallback: error — ${err}`);
      return null;
    }
  }

  $effect(() => {
    let contextReceived = false;

    const b = createWidgetBridge({
      targetWindow: window.parent,
      targetOrigin: '*',
      timeoutMs: 15000,
    });

    bridge = b;
    dbg('bridge created, setting up event handlers…');

    const offInit = b.onEvent('widget:init', (payload) => {
      dbg(`widget:init received: ${JSON.stringify(payload).slice(0, 200)}`);
      initPayload = payload as WidgetInitPayload;
      // widget:init may carry repoContext inline
      if ((payload as any)?.repoContext) {
        const ctx = normalizeRepoContext((payload as any).repoContext);
        if (ctx) {
          contextReceived = true;
          repoContext = ctx;
          dbg('widget:init set repoContext');
        }
      }
    });

    const offRepo = b.onEvent('context:repoUpdate', (ctx) => {
      dbg(`context:repoUpdate received: ${JSON.stringify(ctx).slice(0, 200)}`);
      contextReceived = true;
      repoContext = normalizeRepoContext(ctx) ?? repoContext;
    });

    // Compatibility: flotilla-budabit host sends context:update with {userPubkey, relays, repo:{...}}
    // This handles both the current host behaviour and future budabit-sdk-native hosts.
    const offContextUpdate = b.onEvent('context:update', (ctx: any) => {
      dbg(`context:update received: ${JSON.stringify(ctx).slice(0, 200)}`);
      if (!ctx) return;
      contextReceived = true;
      // Merge pubkey into initPayload if widget:init hasn't arrived yet
      if (ctx.userPubkey && !initPayload) {
        initPayload = { pubkey: ctx.userPubkey, relays: ctx.relays ?? [], hostVersion: '1.0.0' } as WidgetInitPayload;
      }
      // Merge repo context if context:repoUpdate hasn't arrived yet
      if (!repoContext) {
        const nested = ctx.repo ?? ctx;
        const normalized = normalizeRepoContext(nested);
        if (normalized) repoContext = normalized;
      }
    });

    dbg('signalReady() called');
    b.signalReady();

    // Fallback: if the host's push events were lost (timing race), actively
    // request context via context:getRepo with exponential backoff.
    // Retries at 500ms, 1.5s, 3.5s, 7.5s — gives the host time to load the
    // repo Nostr event before each attempt.
    const RETRY_DELAYS = [500, 1000, 2000, 4000];
    let retryIdx = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleNextRetry() {
      if (retryIdx >= RETRY_DELAYS.length) {
        dbg('fallback: all retries exhausted, giving up');
        return;
      }
      const delay = RETRY_DELAYS[retryIdx++];
      retryTimer = setTimeout(async () => {
        retryTimer = null;
        dbg(`fallback retry ${retryIdx}/${RETRY_DELAYS.length}: contextReceived=${contextReceived}, delay was ${delay}ms`);
        if (contextReceived) return;
        const ctx = await fetchRepoContext(b);
        if (contextReceived) return;
        if (ctx) {
          contextReceived = true;
          repoContext = ctx;
          dbg('fallback: repoContext set via context:getRepo');
        } else {
          scheduleNextRetry();
        }
      }, delay);
    }

    scheduleNextRetry();

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      offInit();
      offRepo();
      offContextUpdate();
      b.destroy();
      bridge = null;
    };
  });

  // ── Navigation handlers ───────────────────────────────────────────────────
  function handleViewRelease(event: NostrEvent) {
    selectedEvent = event;
    view = 'detail';
  }

  function handleCreateRelease(apps: SoftwareApplication[]) {
    discoveredApps = apps;
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
      {#if debugLog.length > 0}
        <pre class="debug-log">{debugLog.join('\n')}</pre>
      {/if}
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
      existingApps={discoveredApps}
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

  .debug-log {
    margin: 1rem auto;
    max-width: 600px;
    text-align: left;
    font-family: monospace;
    font-size: 0.7rem;
    line-height: 1.5;
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
