<script lang="ts">
  import type { WidgetBridge } from 'budabit-sdk';
  import type { RepoContext } from '../context.js';
  import type { PipelineArtifactData } from '../pipelines.js';
  import type { SoftwareApplication } from '../types.js';
  import { CHANNELS } from '../types.js';
  import { loadPipelineArtifacts } from '../pipelines.js';
  import { appCoordinate } from '../trust.js';
  import { loadJournal, preparePublication, publishJournal, type PublicationJournal } from '../publication.js';
  import ArtifactSelector from './ArtifactSelector.svelte';
  import { onDestroy } from 'svelte';

  let { bridge, repo, existingApps, onSuccess, onCancel }: {
    bridge: WidgetBridge; repo: RepoContext; existingApps: SoftwareApplication[];
    onSuccess: () => void; onCancel: () => void;
  } = $props();
  const controller = new AbortController();
  onDestroy(() => controller.abort());
  let pipelineData = $state<PipelineArtifactData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let appChoice = $state('');
  let appId = $state('');
  let appName = $state('');
  let runId = $state('');
  let version = $state('');
  let channel = $state<string>('main');
  let notes = $state('');
  let selectedIds = $state(new Set<string>());
  let verifiedIds = $state(new Set<string>());
  let submitting = $state(false);
  let progress = $state('');
  let journal = $state.raw<PublicationJournal | null>(null);
  const app = $derived(existingApps.find(a => appCoordinate(a) === appChoice));
  const artifacts = $derived(pipelineData?.artifactsByRun.get(runId) ?? []);
  const canSubmit = $derived(!loading && !submitting && !journal && !!version.trim() && selectedIds.size > 0 && !!(app?.appId || appId.trim()));

  $effect(() => {
    let disposed = false;
    loading = true;
    loadJournal(bridge, repo)
      .then(async saved => {
        if (disposed) return;
        journal = saved;
        if (!saved) pipelineData = await loadPipelineArtifacts(bridge, repo);
        if (!disposed) loading = false;
      })
      .catch((err: unknown) => { if (!disposed) { error = err instanceof Error ? err.message : String(err); loading = false; } });
    return () => { disposed = true; };
  });
  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    selectedIds = next;
  }
  async function submit(resume = false) {
    if (submitting || (!resume && !canSubmit)) return;
    submitting = true; error = '';
    const snapshot = JSON.parse(JSON.stringify(repo)) as RepoContext;
    try {
      if (!journal) {
        progress = 'Signing fixed release metadata. No events are published until all signatures are verified…';
        journal = await preparePublication(bridge, snapshot, {
          appId: app?.appId ?? appId.trim(), appPubkey: app?.pubkey ?? repo.userPubkey, appName: appName.trim(),
          newApplication: !app, version: version.trim(), channel, releaseNotes: notes.trim(),
          artifacts: artifacts.filter(a => selectedIds.has(a.eventId) && verifiedIds.has(a.eventId)),
        }, controller.signal);
      }
      await publishJournal(bridge, snapshot, journal, controller.signal, message => progress = message);
      if (!controller.signal.aborted) onSuccess();
    } catch (err) {
      if (!controller.signal.aborted) error = `${err instanceof Error ? err.message : String(err)}${journal ? ' Some events may already be published. Resume retries the same signed event IDs.' : ''}`;
    } finally { submitting = false; progress = ''; }
  }
</script>

<div class="create-release">
  <button onclick={onCancel} disabled={submitting}>← Releases</button>
  <h2>New Release</h2>
  <p>Signing as <code>{repo.userPubkey}</code></p>
  {#if loading}<p>Loading authenticated pipeline runs…</p>{/if}
  {#if journal}
    <section>
      <h3>Saved signed publication</h3>
      <p>{journal.events.length} signed events for this repository/account. Resume does not create new signatures.</p>
      <p>Release: <code>{journal.events.at(-1)?.tags.find(t => t[0] === 'd')?.[1]}</code></p>
      <button disabled={submitting} onclick={() => void submit(true)}>Resume publication</button>
    </section>
  {:else}
    <form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
      <fieldset disabled={submitting || loading}>
        <legend>Application and release</legend>
        <label>Application <select bind:value={appChoice}>
          <option value="">Create application under my key</option>
          {#each existingApps as existing (appCoordinate(existing))}<option value={appCoordinate(existing)}>{existing.name} — {existing.pubkey.slice(0, 12)}</option>{/each}
        </select></label>
        {#if !app}
          <label>App identifier <input bind:value={appId} required placeholder="com.example.app" /></label>
          <label>App name <input bind:value={appName} placeholder="Application name" /></label>
        {:else}<code>{appCoordinate(app)}</code>{/if}
        <label>Version <input bind:value={version} required placeholder="1.2.0" /></label>
        <label>Channel <select bind:value={channel}>{#each CHANNELS as ch}<option value={ch}>{ch}</option>{/each}</select></label>
        <p>The same app/version under your key replaces the previous release, even if you change channel.</p>
        <label>Release notes <textarea bind:value={notes} rows="6"></textarea></label>
        <label>Authenticated pipeline run <select bind:value={runId} onchange={() => { selectedIds = new Set(); verifiedIds = new Set(); }}>
          <option value="">Choose a run</option>
          {#each pipelineData?.runs ?? [] as run (run.id)}<option value={run.id}>{run.workflowName} · {run.branch} · {run.commitId.slice(0, 12)} · {new Date(run.createdAt * 1000).toLocaleString()}</option>{/each}
        </select></label>
      </fieldset>
      {#if runId}<ArtifactSelector {artifacts} {selectedIds} {verifiedIds} disabled={submitting} onToggle={toggle} onVerified={id => verifiedIds = new Set(verifiedIds).add(id)} />{/if}
      <button type="submit" disabled={!canSubmit}>Publish Release</button>
    </form>
  {/if}
  {#if progress}<p role="status">{progress}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
</div>

<style>
  .create-release { padding: 1.25rem; }
  fieldset, section { border: 1px solid var(--ext-border); border-radius: 6px; margin: 1rem 0; padding: 1rem; }
  label { display: block; margin: 0.6rem 0; }
  input, select, textarea { display: block; box-sizing: border-box; width: 100%; padding: 0.5rem; background: var(--ext-surface); color: var(--ext-text); border: 1px solid var(--ext-border); border-radius: 4px; }
  button { padding: 0.5rem 0.8rem; color: var(--ext-accent-text); background: var(--ext-accent); border: none; border-radius: 4px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  p { color: var(--ext-text-secondary); font-size: 0.85rem; overflow-wrap: anywhere; }
  code { overflow-wrap: anywhere; }
  .error { color: var(--ext-danger-text); }
</style>
