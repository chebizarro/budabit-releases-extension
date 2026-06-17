<script lang="ts">
  import type { WidgetBridge, RepoContext } from 'budabit-sdk';
  import type { NostrEvent, Release } from '../types.js';
  import { loadReleaseDetail, formatBytes, formatDate, shortHash } from '../releases.js';

  interface Props {
    bridge: WidgetBridge;
    repo: RepoContext;
    releaseEvent: NostrEvent;
    onBack: () => void;
  }

  let { bridge, repo, releaseEvent, onBack }: Props = $props();

  let release = $state<Release | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!bridge || !releaseEvent) return;

    loading = true;
    error = null;
    release = null;

    loadReleaseDetail(bridge, repo, releaseEvent)
      .then((r) => {
        release = r;
        loading = false;
      })
      .catch((err) => {
        error = err instanceof Error ? err.message : String(err);
        loading = false;
      });
  });
</script>

<div class="release-detail">
  <div class="detail-header">
    <button class="btn-back" onclick={onBack}>← Releases</button>
    {#if release}
      <span class="tag-badge">{release.version}</span>
    {/if}
  </div>

  {#if loading}
    <div class="state-message">Loading release…</div>
  {:else if error}
    <div class="state-error">Failed to load release: {error}</div>
  {:else if release}
    <div class="release-content">
      <div class="release-headline">
        <h2>{release.version}</h2>
        <div class="release-meta">
          <span>{formatDate(release.createdAt)}</span>
          {#if release.commitId}
            <span class="meta-sep">·</span>
            <span class="commit-hash" title={release.commitId}>{shortHash(release.commitId)}</span>
          {/if}
        </div>
      </div>

      {#if release.releaseNotes}
        <section class="notes-section">
          <h3>Release Notes</h3>
          <pre class="release-notes">{release.releaseNotes}</pre>
        </section>
      {/if}

      <section class="artifacts-section">
        <h3>Artifacts ({release.artifacts.length})</h3>
        {#if release.artifacts.length === 0}
          <p class="no-artifacts">No artifacts attached to this release.</p>
        {:else}
          <div class="table-wrap">
            <table class="artifact-table">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Type</th>
                  <th>SHA-256</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#each release.artifacts as artifact (artifact.eventId)}
                  <tr>
                    <td class="col-filename">{artifact.filename}</td>
                    <td class="col-size">{artifact.size != null ? formatBytes(artifact.size) : '—'}</td>
                    <td class="col-mime">{artifact.mimeType}</td>
                    <td class="col-hash" title={artifact.sha256}>{shortHash(artifact.sha256)}</td>
                    <td class="col-dl">
                      <a class="btn-download" href={artifact.url} target="_blank" rel="noreferrer">
                        Download
                      </a>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .release-detail {
    padding: 1.25rem;
  }

  .detail-header {
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

  .tag-badge {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    background: #e8f0fe;
    color: #1558c0;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    font-family: monospace;
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

  .release-headline {
    margin-bottom: 1.25rem;
  }

  h2 {
    margin: 0 0 0.25rem;
    font-size: 1.3rem;
    font-weight: 700;
    color: #111;
    font-family: monospace;
  }

  .release-meta {
    font-size: 0.8rem;
    color: #888;
  }

  .meta-sep {
    margin: 0 0.35rem;
  }

  .commit-hash {
    font-family: monospace;
    color: #555;
  }

  section {
    margin-bottom: 1.5rem;
  }

  h3 {
    margin: 0 0 0.6rem;
    font-size: 0.95rem;
    font-weight: 600;
    color: #333;
    border-bottom: 1px solid #eee;
    padding-bottom: 0.4rem;
  }

  .release-notes {
    margin: 0;
    white-space: pre-wrap;
    font-family: inherit;
    font-size: 0.875rem;
    line-height: 1.6;
    color: #444;
    background: #f8f9fa;
    border: 1px solid #e8e8e8;
    border-radius: 6px;
    padding: 0.85rem 1rem;
    overflow-x: auto;
  }

  .no-artifacts {
    margin: 0;
    color: #888;
    font-size: 0.875rem;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid #e8e8e8;
    border-radius: 6px;
  }

  .artifact-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .artifact-table thead {
    background: #f8f9fa;
  }

  .artifact-table th {
    text-align: left;
    padding: 0.55rem 0.75rem;
    font-weight: 600;
    color: #555;
    border-bottom: 1px solid #e8e8e8;
    white-space: nowrap;
  }

  .artifact-table td {
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid #f0f0f0;
    color: #333;
    vertical-align: middle;
  }

  .artifact-table tr:last-child td {
    border-bottom: none;
  }

  .col-filename {
    font-family: monospace;
    word-break: break-all;
  }

  .col-size,
  .col-mime {
    white-space: nowrap;
    color: #666;
  }

  .col-hash {
    font-family: monospace;
    color: #666;
    white-space: nowrap;
  }

  .col-dl {
    text-align: right;
    white-space: nowrap;
  }

  .btn-download {
    display: inline-block;
    padding: 0.3rem 0.7rem;
    background: #1a73e8;
    color: #fff;
    text-decoration: none;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 500;
  }

  .btn-download:hover {
    background: #1558c0;
  }
</style>
