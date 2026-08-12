<script lang="ts">
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import type { NostrEvent, RepoContext, WidgetBridge } from 'budabit-sdk';
  import type { SoftwareRelease } from '../types.js';
  import {
    loadReleaseDetail,
    formatBytes,
    formatDate,
    shortHash,
    assetDownloadUrl,
    platformLabel,
  } from '../releases.js';

  interface Props {
    bridge: WidgetBridge;
    repo: RepoContext;
    releaseEvent: NostrEvent;
    onBack: () => void;
  }

  let { bridge, repo, releaseEvent, onBack }: Props = $props();

  let release = $state<SoftwareRelease | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Open every rendered link in a new tab — in-place navigation would replace
  // the widget iframe itself.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  /** Release notes are untrusted event content: parse as markdown, sanitize the HTML. */
  const notesHtml = $derived.by(() => {
    const notes = release?.releaseNotes;
    if (!notes) return '';
    try {
      return DOMPurify.sanitize(marked.parse(notes, { async: false, gfm: true }) as string);
    } catch {
      return '';
    }
  });

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
      {#if release.channel && release.channel !== 'main'}
        <span class="channel-badge">{release.channel}</span>
      {/if}
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
          {#if release.appId}
            <span class="meta-sep">·</span>
            <span class="meta-app" title="Application identifier">{release.appId}</span>
          {/if}
          {#if release.channel}
            <span class="meta-sep">·</span>
            <span class="meta-channel">{release.channel}</span>
          {/if}
        </div>
      </div>

      {#if release.releaseNotes}
        <section class="notes-section">
          <h3>Release Notes</h3>
          {#if notesHtml}
            <div class="release-notes markdown-body">{@html notesHtml}</div>
          {:else}
            <pre class="release-notes release-notes-plain">{release.releaseNotes}</pre>
          {/if}
        </section>
      {/if}

      <section class="artifacts-section">
        <h3>Assets ({release.assets.length})</h3>
        {#if release.assets.length === 0}
          <p class="no-artifacts">No assets attached to this release.</p>
        {:else}
          <div class="table-wrap">
            <table class="artifact-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Platform</th>
                  <th>Size</th>
                  <th>MIME Type</th>
                  <th>SHA-256</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#each release.assets as asset (asset.eventId)}
                  <tr>
                    <td class="col-filename">
                      <a
                        class="filename-link"
                        href={assetDownloadUrl(asset)}
                        target="_blank"
                        rel="noreferrer"
                        title="Download {asset.filename}">{asset.filename}</a>
                      {#if asset.variant}
                        <span class="variant-label">{asset.variant}</span>
                      {/if}
                    </td>
                    <td class="col-platform">{platformLabel(asset.platforms)}</td>
                    <td class="col-size">{asset.size != null ? formatBytes(asset.size) : '—'}</td>
                    <td class="col-mime">{asset.mimeType}</td>
                    <td class="col-hash" title={asset.sha256}>{shortHash(asset.sha256)}</td>
                    <td class="col-dl">
                      <a class="btn-download" href={assetDownloadUrl(asset)} target="_blank" rel="noreferrer">
                        Download
                      </a>
                    </td>
                  </tr>
                  {#if asset.commitId || asset.minPlatformVersion || asset.versionCode != null}
                    <tr class="asset-extra-row">
                      <td colspan="6" class="asset-extra">
                        {#if asset.commitId}
                          <span class="extra-item">
                            <span class="extra-label">commit</span>
                            <code>{asset.commitId.slice(0, 10)}</code>
                          </span>
                        {/if}
                        {#if asset.versionCode != null}
                          <span class="extra-item">
                            <span class="extra-label">version code</span>
                            {asset.versionCode}
                          </span>
                        {/if}
                        {#if asset.minPlatformVersion}
                          <span class="extra-item">
                            <span class="extra-label">min platform</span>
                            {asset.minPlatformVersion}
                          </span>
                        {/if}
                      </td>
                    </tr>
                  {/if}
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
    color: var(--ext-accent);
    font-size: 0.875rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
  }

  .btn-back:hover {
    background: var(--ext-accent-soft);
  }

  .tag-badge {
    display: inline-block;
    padding: 0.2rem 0.6rem;
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

  .release-headline {
    margin-bottom: 1.25rem;
  }

  h2 {
    margin: 0 0 0.25rem;
    font-size: 1.3rem;
    font-weight: 700;
    color: var(--ext-text);
    font-family: monospace;
  }

  .release-meta {
    font-size: 0.8rem;
    color: var(--ext-text-muted);
  }

  .meta-sep {
    margin: 0 0.35rem;
  }

  .meta-app {
    font-family: monospace;
    color: var(--ext-text-secondary);
  }

  .meta-channel {
    text-transform: uppercase;
    font-weight: 600;
    font-size: 0.75rem;
    letter-spacing: 0.03em;
  }

  section {
    margin-bottom: 1.5rem;
  }

  h3 {
    margin: 0 0 0.6rem;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--ext-text);
    border-bottom: 1px solid var(--ext-border);
    padding-bottom: 0.4rem;
  }

  .release-notes {
    margin: 0;
    font-family: inherit;
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--ext-text-secondary);
    background: var(--ext-surface-2);
    border: 1px solid var(--ext-border);
    border-radius: 6px;
    padding: 0.85rem 1rem;
    overflow-x: auto;
  }

  .release-notes-plain {
    white-space: pre-wrap;
  }

  /* Rendered markdown */
  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4) {
    margin: 1em 0 0.4em;
    color: var(--ext-text);
    font-weight: 600;
    line-height: 1.3;
    border: none;
    padding: 0;
  }

  .markdown-body :global(h1) { font-size: 1.15rem; }
  .markdown-body :global(h2) { font-size: 1.05rem; }
  .markdown-body :global(h3) { font-size: 0.95rem; }
  .markdown-body :global(h4) { font-size: 0.9rem; }

  .markdown-body :global(> :first-child) { margin-top: 0; }
  .markdown-body :global(> :last-child) { margin-bottom: 0; }

  .markdown-body :global(p) {
    margin: 0.5em 0;
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: 0.5em 0;
    padding-left: 1.5em;
  }

  .markdown-body :global(li) {
    margin: 0.2em 0;
  }

  .markdown-body :global(a) {
    color: var(--ext-accent);
    text-decoration: none;
  }

  .markdown-body :global(a:hover) {
    text-decoration: underline;
  }

  .markdown-body :global(code) {
    font-family: monospace;
    font-size: 0.82em;
    background: var(--ext-surface);
    border: 1px solid var(--ext-border);
    border-radius: 3px;
    padding: 0.1em 0.35em;
  }

  .markdown-body :global(pre) {
    background: var(--ext-code-bg);
    color: var(--ext-code-text);
    border-radius: 6px;
    padding: 0.75rem 0.9rem;
    overflow-x: auto;
    margin: 0.6em 0;
  }

  .markdown-body :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font-size: 0.8rem;
  }

  .markdown-body :global(blockquote) {
    margin: 0.6em 0;
    padding: 0.1em 0 0.1em 0.9em;
    border-left: 3px solid var(--ext-border-strong);
    color: var(--ext-text-muted);
  }

  .markdown-body :global(hr) {
    border: none;
    border-top: 1px solid var(--ext-border);
    margin: 1em 0;
  }

  .markdown-body :global(img) {
    max-width: 100%;
  }

  .markdown-body :global(table) {
    border-collapse: collapse;
    margin: 0.6em 0;
  }

  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--ext-border);
    padding: 0.3em 0.6em;
    font-size: 0.82rem;
  }

  .no-artifacts {
    margin: 0;
    color: var(--ext-text-muted);
    font-size: 0.875rem;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--ext-border);
    border-radius: 6px;
  }

  .artifact-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .artifact-table thead {
    background: var(--ext-surface-2);
  }

  .artifact-table th {
    text-align: left;
    padding: 0.55rem 0.75rem;
    font-weight: 600;
    color: var(--ext-text-secondary);
    border-bottom: 1px solid var(--ext-border);
    white-space: nowrap;
  }

  .artifact-table td {
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid var(--ext-surface-2);
    color: var(--ext-text);
    vertical-align: middle;
  }

  .artifact-table tr:last-child td {
    border-bottom: none;
  }

  .col-filename {
    font-family: monospace;
    word-break: break-all;
  }

  .filename-link {
    color: var(--ext-accent);
    text-decoration: none;
  }

  .filename-link:hover {
    text-decoration: underline;
  }

  .variant-label {
    display: inline-block;
    margin-left: 0.3rem;
    padding: 0.05rem 0.35rem;
    background: var(--ext-surface-2);
    color: var(--ext-text-muted);
    border-radius: 3px;
    font-size: 0.7rem;
  }

  .col-platform {
    white-space: nowrap;
    font-size: 0.8rem;
    color: var(--ext-text-secondary);
  }

  .col-size,
  .col-mime {
    white-space: nowrap;
    color: var(--ext-text-muted);
  }

  .col-hash {
    font-family: monospace;
    color: var(--ext-text-muted);
    white-space: nowrap;
  }

  .col-dl {
    text-align: right;
    white-space: nowrap;
  }

  .btn-download {
    display: inline-block;
    padding: 0.3rem 0.7rem;
    background: var(--ext-accent);
    color: var(--ext-accent-text);
    text-decoration: none;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 500;
  }

  .btn-download:hover {
    background: var(--ext-accent-hover);
  }

  .asset-extra-row td {
    padding-top: 0;
    border-bottom: 1px solid var(--ext-border);
  }

  .asset-extra {
    display: flex;
    gap: 1rem;
    font-size: 0.75rem;
    color: var(--ext-text-muted);
    padding-bottom: 0.5rem;
  }

  .extra-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .extra-label {
    font-weight: 600;
    color: var(--ext-text-faint);
  }

  .asset-extra code {
    font-family: monospace;
    background: var(--ext-surface-2);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    font-size: 0.72rem;
  }
</style>
