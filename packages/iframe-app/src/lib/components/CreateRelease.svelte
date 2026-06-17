<script lang="ts">
  import type { WidgetBridge, RepoContext } from 'budabit-sdk';
  import type { PipelineArtifactData } from '../pipelines.js';
  import { loadPipelineArtifacts } from '../pipelines.js';
  import { buildReleaseEvent } from '../releases.js';
  import { publishEvent, getRelays } from '../bridge.js';
  import ArtifactSelector from './ArtifactSelector.svelte';

  interface Props {
    bridge: WidgetBridge;
    repo: RepoContext;
    trustedMaintainers: string[];
    onSuccess: () => void;
    onCancel: () => void;
  }

  let { bridge, repo, trustedMaintainers, onSuccess, onCancel }: Props = $props();

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

  // ── Form state ────────────────────────────────────────────────────────────
  let version = $state('');
  let releaseNotes = $state('');
  let selectedIds = $state(new Set<string>());
  let submitting = $state(false);
  let submitError = $state<string | null>(null);

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
    version.trim().length > 0 && selectedIds.size > 0 && !submitting
  );

  async function handleSubmit() {
    if (!canSubmit || !bridge || !repo?.repoNaddr) return;

    // Resolve the consensus artifact event IDs in declaration order
    const groups = pipelineData?.groups ?? [];
    const orderedIds: string[] = [];
    for (const group of groups) {
      if (!group.consensusHash) continue;
      const artifact = group.sha256Counts.get(group.consensusHash)?.[0];
      if (artifact && selectedIds.has(artifact.eventId)) {
        orderedIds.push(artifact.eventId);
      }
    }

    if (orderedIds.length === 0) {
      submitError = 'No valid artifacts selected.';
      return;
    }

    submitting = true;
    submitError = null;

    const relays = getRelays(repo.repoRelays);
    const repoRelay = relays[0] ?? '';

    // Derive commitId from any of the selected artifacts
    const allArtifacts = pipelineData?.allArtifacts ?? [];
    const commitId = allArtifacts.find(
      (a) => selectedIds.has(a.eventId) && a.commitId
    )?.commitId;

    const event = buildReleaseEvent({
      version: version.trim(),
      repoNaddr: repo.repoNaddr,
      repoRelay,
      artifactEventIds: orderedIds,
      releaseNotes: releaseNotes.trim(),
      commitId,
    });

    try {
      await publishEvent(bridge, event);
      onSuccess();
    } catch (err) {
      submitError = err instanceof Error ? err.message : String(err);
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
    <!-- Version -->
    <div class="field">
      <label for="version">Version tag <span class="required">*</span></label>
      <input
        id="version"
        type="text"
        bind:value={version}
        placeholder="e.g. v1.2.0"
        required
        disabled={submitting}
      />
    </div>

    <!-- Release notes -->
    <div class="field">
      <label for="notes">Release notes</label>
      <textarea
        id="notes"
        bind:value={releaseNotes}
        rows={6}
        placeholder="Describe what changed in this release…"
        disabled={submitting}
      ></textarea>
    </div>

    <!-- Artifact picker -->
    <div class="field">
      <label>
        Artifacts <span class="required">*</span>
        <span class="label-hint">(select artifacts from recent pipeline runs)</span>
      </label>

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
            {selectedIds.size} artifact{selectedIds.size !== 1 ? 's' : ''} selected
          </p>
        {/if}
      {/if}
    </div>

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

  .field {
    margin-bottom: 1.25rem;
  }

  label {
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

  input[type='text'],
  textarea {
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
  textarea:focus {
    outline: none;
    border-color: #1a73e8;
    box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.15);
  }

  input:disabled,
  textarea:disabled {
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
