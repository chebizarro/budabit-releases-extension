<script lang="ts">
  import type { WidgetBridge } from '../bridge.js';
  import type { RepoContext } from '../types.js';
  import type { PipelineArtifactData } from '../pipelines.js';
  import type { SoftwareApplication } from '../types.js';
  import { CHANNELS } from '../types.js';
  import { loadPipelineArtifacts } from '../pipelines.js';
  import {
    buildApplicationEvent,
    createRelease,
  } from '../releases.js';
  import { publishEvent, getRelays } from '../bridge.js';
  import ArtifactSelector from './ArtifactSelector.svelte';

  interface Props {
    bridge: WidgetBridge;
    repo: RepoContext;
    trustedMaintainers: string[];
    existingApps: SoftwareApplication[];
    onSuccess: () => void;
    onCancel: () => void;
  }

  let { bridge, repo, trustedMaintainers, existingApps, onSuccess, onCancel }: Props = $props();

  // ── Pipeline artifact state ───────────────────────────────────────────────
  let pipelineData = $state<PipelineArtifactData | null>(null);
  let loadingArtifacts = $state(true);
  let artifactError = $state<string | null>(null);

  $effect(() => {
    if (!bridge || !repo) return;
    loadingArtifacts = true;
    artifactError = null;
    loadPipelineArtifacts(bridge, repo, trustedMaintainers)
      .then((data) => {
        pipelineData = data;
        loadingArtifacts = false;
      })
      .catch((err) => {
        artifactError = err instanceof Error ? err.message : String(err);
        loadingArtifacts = false;
      });
  });

  // ── App state ─────────────────────────────────────────────────────────────
  const hasExistingApp = $derived(existingApps.length > 0);
  const defaultAppId = $derived(
    existingApps[0]?.appId ?? repo.repoName ?? ''
  );
  const defaultAppName = $derived(
    existingApps[0]?.name ?? repo.repoName ?? ''
  );

  let appId = $state('');
  let appName = $state('');

  // Initialize from defaults once available
  $effect(() => {
    if (!appId && defaultAppId) appId = defaultAppId;
    if (!appName && defaultAppName) appName = defaultAppName;
  });

  // ── Form state ────────────────────────────────────────────────────────────
  let version = $state('');
  let channel = $state<string>('main');
  let releaseNotes = $state('');
  let selectedIds = $state(new Set<string>());
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let publishProgress = $state('');

  function toggleArtifact(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    selectedIds = next;
  }

  const canSubmit = $derived(
    version.trim().length > 0 &&
      selectedIds.size > 0 &&
      appId.trim().length > 0 &&
      !submitting
  );

  async function handleSubmit() {
    if (!canSubmit || !bridge || !repo) return;

    // Resolve the consensus artifact objects in declaration order
    const groups = pipelineData?.groups ?? [];
    const selectedArtifacts: import('../types.js').Artifact[] = [];
    for (const group of groups) {
      if (!group.consensusHash) continue;
      const artifact = group.sha256Counts.get(group.consensusHash)?.[0];
      if (artifact && selectedIds.has(artifact.eventId)) {
        selectedArtifacts.push(artifact);
      }
    }

    if (selectedArtifacts.length === 0) {
      submitError = 'No valid artifacts selected.';
      return;
    }

    submitting = true;
    submitError = null;

    const relays = getRelays(repo.repoRelays);

    try {
      // Step 1: Create the application event if it doesn't exist
      if (!hasExistingApp) {
        publishProgress = 'Publishing application event…';
        const repoAddr = repo.repoNaddr ?? '';
        const appEvent = buildApplicationEvent({
          appId: appId.trim(),
          name: appName.trim() || appId.trim(),
          repoAddress: repoAddr,
          repoRelay: relays[0] ?? '',
        });
        await publishEvent(bridge, appEvent, relays);
      }

      // Step 2: Create kind 3063 assets + kind 30063 release (handled by createRelease)
      const totalSteps = selectedArtifacts.length + 1;
      let step = 0;

      // We need to intercept progress, but createRelease is atomic.
      // For UX, just show a single progress message.
      publishProgress = `Publishing ${selectedArtifacts.length} asset${selectedArtifacts.length !== 1 ? 's' : ''} and release…`;

      // Derive commitId from selected artifacts
      const commitId = selectedArtifacts.find((a) => a.commitId)?.commitId;

      await createRelease(bridge, relays, {
        appId: appId.trim(),
        version: version.trim(),
        channel,
        releaseNotes: releaseNotes.trim(),
        artifacts: selectedArtifacts,
        commitId,
      });

      publishProgress = '';
      onSuccess();
    } catch (err) {
      submitError = err instanceof Error ? err.message : String(err);
      publishProgress = '';
      submitting = false;
    }
  }
</script>

<div class="create-release">
  <div class="create-header">
    <button class="btn-back" onclick={onCancel}>← Cancel</button>
    <h2>New Release</h2>
  </div>

  <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
    <!-- Application identifier -->
    {#if !hasExistingApp}
      <fieldset class="app-setup">
        <legend>Application Setup</legend>
        <p class="setup-hint">No application event found for this repository. One will be created with your first release.</p>
        <div class="field-row">
          <div class="field">
            <label for="appId">App Identifier <span class="required">*</span></label>
            <input
              id="appId"
              type="text"
              bind:value={appId}
              placeholder="e.g. com.example.myapp"
              required
              disabled={submitting}
            />
            <span class="field-hint">Reverse-domain notation recommended</span>
          </div>
          <div class="field">
            <label for="appName">App Name</label>
            <input
              id="appName"
              type="text"
              bind:value={appName}
              placeholder="My Application"
              disabled={submitting}
            />
          </div>
        </div>
      </fieldset>
    {:else}
      <div class="app-badge">
        <span class="app-label">App:</span>
        <code>{appId}</code>
      </div>
    {/if}

    <!-- Version + Channel -->
    <div class="field-row">
      <div class="field field-grow">
        <label for="version">Version <span class="required">*</span></label>
        <input
          id="version"
          type="text"
          bind:value={version}
          placeholder="e.g. 1.2.0 or v1.2.0-rc1"
          required
          disabled={submitting}
        />
      </div>
      <div class="field field-fixed">
        <label for="channel">Channel</label>
        <select id="channel" bind:value={channel} disabled={submitting}>
          {#each CHANNELS as ch}
            <option value={ch}>{ch}</option>
          {/each}
        </select>
      </div>
    </div>

    <!-- Release notes -->
    <div class="field">
      <label for="notes">Release notes</label>
      <textarea
        id="notes"
        bind:value={releaseNotes}
        rows={6}
        placeholder="Describe what changed in this release… (Markdown supported)"
        disabled={submitting}
      ></textarea>
    </div>

    <!-- Artifact picker -->
    <div class="field">
      <span class="field-label" id="assets-label">
        Assets <span class="required">*</span>
        <span class="label-hint">(select build artifacts to include as kind 3063 assets)</span>
      </span>

      {#if loadingArtifacts}
        <p class="sub-message">Loading pipeline artifacts…</p>
      {:else if artifactError}
        <p class="sub-error">Could not load artifacts: {artifactError}</p>
      {:else}
        <ArtifactSelector
          groups={pipelineData?.groups ?? []}
          {selectedIds}
          onToggle={toggleArtifact}
        />
        {#if (pipelineData?.groups.length ?? 0) > 0}
          <p class="selection-count">
            {selectedIds.size} asset{selectedIds.size !== 1 ? 's' : ''} selected
          </p>
        {/if}
      {/if}
    </div>

    {#if publishProgress}
      <div class="progress-msg">{publishProgress}</div>
    {/if}

    {#if submitError}
      <div class="submit-error">{submitError}</div>
    {/if}

    <div class="actions">
      <button type="button" class="btn-secondary" onclick={onCancel} disabled={submitting}>
        Cancel
      </button>
      <button type="submit" class="btn-primary" disabled={!canSubmit}>
        {submitting ? 'Publishing…' : 'Publish Release'}
      </button>
    </div>
  </form>
</div>

<style>
  .create-release {
    padding: 1.25rem;
  }

  .create-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }

  .btn-back {
    background: none;
    border: none;
    color: #1a73e8;
    font-size: 0.875rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
  }

  .btn-back:hover {
    background: #e8f0fe;
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
    color: #111;
  }

  .app-setup {
    border: 1px solid #d0d7de;
    border-radius: 8px;
    padding: 1rem 1.1rem;
    margin-bottom: 1.25rem;
    background: #f8f9fa;
  }

  .app-setup legend {
    font-size: 0.875rem;
    font-weight: 600;
    color: #333;
    padding: 0 0.4rem;
  }

  .setup-hint {
    margin: 0 0 0.75rem;
    font-size: 0.8rem;
    color: #666;
  }

  .app-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
    padding: 0.5rem 0.75rem;
    background: #f0f6ff;
    border: 1px solid #cce0ff;
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .app-label {
    color: #555;
    font-weight: 600;
  }

  .app-badge code {
    font-family: monospace;
    color: #1558c0;
    font-size: 0.85rem;
  }

  .field-row {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }

  .field-grow {
    flex: 1 1 auto;
  }

  .field-fixed {
    flex: 0 0 auto;
    min-width: 120px;
  }

  .field {
    margin-bottom: 1.25rem;
  }

  .field-row .field {
    margin-bottom: 0;
  }

  label,
  .field-label {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: #333;
    margin-bottom: 0.4rem;
  }

  .required {
    color: #c62828;
  }

  .label-hint {
    font-weight: 400;
    color: #888;
    font-size: 0.8rem;
    margin-left: 0.3rem;
  }

  .field-hint {
    display: block;
    margin-top: 0.2rem;
    font-size: 0.75rem;
    color: #999;
  }

  input[type='text'],
  textarea,
  select {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.65rem;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font-size: 0.875rem;
    font-family: inherit;
    color: #111;
    background: #fff;
    transition: border-color 0.15s;
  }

  input[type='text']:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: #1a73e8;
    box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.15);
  }

  input:disabled,
  textarea:disabled,
  select:disabled {
    background: #f6f6f6;
    color: #888;
  }

  .sub-message {
    margin: 0.25rem 0 0;
    color: #888;
    font-size: 0.875rem;
  }

  .sub-error {
    margin: 0.25rem 0 0;
    color: #c62828;
    font-size: 0.875rem;
    background: #fce4e4;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
  }

  .selection-count {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: #555;
  }

  .progress-msg {
    margin-bottom: 1rem;
    padding: 0.6rem 0.85rem;
    background: #e8f0fe;
    border: 1px solid #cce0ff;
    border-radius: 6px;
    color: #1558c0;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .submit-error {
    margin-bottom: 1rem;
    padding: 0.6rem 0.85rem;
    background: #fce4e4;
    border: 1px solid #f5c6cb;
    border-radius: 6px;
    color: #c62828;
    font-size: 0.875rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
  }

  .btn-primary {
    padding: 0.45rem 1rem;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-primary:hover:not(:disabled) {
    background: #1558c0;
  }

  .btn-primary:disabled {
    background: #9fc3f8;
    cursor: not-allowed;
  }

  .btn-secondary {
    padding: 0.45rem 1rem;
    background: #fff;
    color: #333;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-secondary:hover:not(:disabled) {
    background: #f6f8fa;
  }

  .btn-secondary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
