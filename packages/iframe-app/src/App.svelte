<script lang="ts">
  import {
    createWidgetBridge,
    type NostrEvent,
    type RepoContext,
    type WidgetBridge,
    type WidgetInitPayload,
  } from 'budabit-sdk';
  import { watchHostTheme } from './lib/host-theme';
  import type { SoftwareApplication } from './lib/types.js';
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
   *   - context:update     → legacy { repo, userPubkey, relays } fallback (v1 only)
   */
  function normalizeRepoContext(input: unknown): RepoContext | null {
    if (!input || typeof input !== 'object') return null;
    const value = input as Record<string, unknown>;
    const stringArray = (candidate: unknown): string[] =>
      Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === 'string') : [];

    // Already normalized by a current client or compatible host.
    if (typeof value.repoPubkey === 'string' || typeof value.repoNaddr === 'string') {
      return {
        repoPubkey: typeof value.repoPubkey === 'string' ? value.repoPubkey : '',
        repoName: typeof value.repoName === 'string' ? value.repoName : '',
        repoNaddr: typeof value.repoNaddr === 'string' ? value.repoNaddr : '',
        repoRelays: stringArray(value.repoRelays),
        maintainers: stringArray(value.maintainers),
      };
    }

    // Runtime host shape (pubkey, name, naddr, relays).
    if (typeof value.pubkey === 'string' && typeof value.name === 'string') {
      return {
        repoPubkey: value.pubkey,
        repoName: value.name,
        repoNaddr: typeof value.naddr === 'string' ? value.naddr : '',
        repoRelays: stringArray(value.relays),
        maintainers: stringArray(value.maintainers),
      };
    }
    return null;
  }

  $effect(() => {
    const b = createWidgetBridge({
      targetWindow: window.parent,
      targetOrigin: '*',
      timeoutMs: 15000,
    });

    bridge = b;
    dbg('bridge created, setting up event handlers…');

    // Match the host application's theme (light/dark + background)
    const offTheme = watchHostTheme(b);

    // widget:init — sent first by the host; may carry repoContext inline.
    const offInit = b.onEvent('widget:init', (payload) => {
      dbg(`widget:init received: ${JSON.stringify(payload).slice(0, 200)}`);
      initPayload = payload as WidgetInitPayload;
      const initialRepo = payload.repoContext ?? payload.repo;
      if (initialRepo) {
        const ctx = normalizeRepoContext(initialRepo);
        if (ctx) {
          repoContext = ctx;
          dbg('widget:init set repoContext');
        }
      }
    });

    // context:repoUpdate — flat RepoContext pushed whenever repo data changes.
    const offRepo = b.onEvent('context:repoUpdate', (ctx) => {
      dbg(`context:repoUpdate received: ${JSON.stringify(ctx).slice(0, 200)}`);
      repoContext = normalizeRepoContext(ctx) ?? repoContext;
    });

    // Legacy v1 fallback only. context:update is deprecated and will be removed in host v2.
    const offContextUpdate = b.onEvent('context:update', (ctx) => {
      dbg(`legacy context:update received: ${JSON.stringify(ctx).slice(0, 200)}`);
      if (!ctx) return;
      if (ctx.userPubkey && !initPayload) {
        initPayload = { pubkey: ctx.userPubkey, relays: ctx.relays ?? [], hostVersion: '1.0.0' };
      }
      if (!repoContext) {
        const normalized = normalizeRepoContext(ctx.repo ?? ctx);
        if (normalized) repoContext = normalized;
      }
    });

    dbg('signalReady() called');
    b.signalReady();

    return () => {
      offTheme();
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
  /* Theme tokens — lib/host-theme.ts sets `data-theme` on <html> from the
     host's widget:init / widget:themeChanged events. */
  :global(:root) {
    color-scheme: light;
    --ext-bg: #ffffff;
    --ext-surface: #ffffff;
    --ext-surface-2: #f8f9fa;
    --ext-border: #e8e8e8;
    --ext-border-strong: #d0d7de;
    --ext-text: #111111;
    --ext-text-secondary: #555555;
    --ext-text-muted: #666666;
    --ext-text-faint: #999999;
    --ext-accent: #1a73e8;
    --ext-accent-hover: #1558c0;
    --ext-accent-text: #ffffff;
    --ext-accent-soft: #e8f0fe;
    --ext-accent-soft-2: #f0f6ff;
    --ext-accent-soft-border: #cce0ff;
    --ext-accent-muted: #9fc3f8;
    --ext-danger-bg: #fce4e4;
    --ext-danger-border: #f5c6cb;
    --ext-danger-text: #c62828;
    --ext-warning-bg: #fff3cd;
    --ext-warning-text: #856404;
    --ext-success-bg: #e6f4ea;
    --ext-success-text: #1e7e34;
    --ext-code-bg: #1e1e1e;
    --ext-code-text: #d4d4d4;
  }

  :global([data-theme='dark']) {
    color-scheme: dark;
    --ext-bg: #151c23;
    --ext-surface: #1e2831;
    --ext-surface-2: #232e39;
    --ext-border: #33404c;
    --ext-border-strong: #40505e;
    --ext-text: #e6ebf0;
    --ext-text-secondary: #c3ccd5;
    --ext-text-muted: #98a6b3;
    --ext-text-faint: #78889a;
    --ext-accent: #4a9eff;
    --ext-accent-hover: #74b6ff;
    --ext-accent-text: #ffffff;
    --ext-accent-soft: #1c3250;
    --ext-accent-soft-2: #1a2c44;
    --ext-accent-soft-border: #2c4a74;
    --ext-accent-muted: #3f6ea8;
    --ext-danger-bg: #3b1d21;
    --ext-danger-border: #7a3a42;
    --ext-danger-text: #f1a7ad;
    --ext-warning-bg: #3f3520;
    --ext-warning-text: #e8c869;
    --ext-success-bg: #14321f;
    --ext-success-text: #7fd6a0;
    --ext-code-bg: #10161c;
    --ext-code-text: #c9d4de;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell,
      sans-serif;
    background: var(--host-background, var(--ext-bg));
    font-size: 14px;
    color: var(--ext-text);
  }

  .app {
    min-height: 100vh;
  }

  .initializing,
  .no-context {
    padding: 2rem;
    text-align: center;
    color: var(--ext-text-muted);
    font-size: 0.9rem;
  }

  .no-context p {
    margin: 0 0 0.5rem;
  }

  .hint {
    color: var(--ext-text-faint);
    font-size: 0.8rem;
  }

  .debug-log {
    margin: 1rem auto;
    max-width: 600px;
    text-align: left;
    font-family: monospace;
    font-size: 0.7rem;
    line-height: 1.5;
    background: var(--ext-code-bg);
    color: var(--ext-code-text);
    padding: 0.75rem 1rem;
    border-radius: 6px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
