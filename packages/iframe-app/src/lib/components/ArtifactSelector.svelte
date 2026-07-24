<script lang="ts">
  import type { ArtifactGroup } from '../types.js';
  import { getConsensusStatus, type ConsensusStatus } from '../types.js';
  import { formatBytes, shortHash } from '../releases.js';

  interface Props {
    groups: ArtifactGroup[];
    selectedIds: Set<string>;
    onToggle: (artifactId: string) => void;
  }

  let { groups, selectedIds, onToggle }: Props = $props();

  function consensusLabel(status: ConsensusStatus): string {
    if (status === 'unanimous') return '✓ Unanimous';
    if (status === 'majority') return '~ Majority';
    return '⚠ Split';
  }

  function consensusClass(status: ConsensusStatus): string {
    if (status === 'unanimous') return 'status-ok';
    if (status === 'majority') return 'status-warn';
    return 'status-bad';
  }

  function bestArtifact(group: ArtifactGroup) {
    if (!group.consensusHash) return null;
    return group.sha256Counts.get(group.consensusHash)?.[0] ?? null;
  }

  function workerCount(group: ArtifactGroup): number {
    return [...group.sha256Counts.values()].reduce((n, a) => n + a.length, 0);
  }
</script>

{#if groups.length === 0}
  <p class="empty">No artifacts found from recent pipeline runs.</p>
{:else}
  <div class="table-wrap">
    <table class="artifact-table">
      <thead>
        <tr>
          <th class="col-check"></th>
          <th>Filename</th>
          <th>Consensus</th>
          <th>SHA-256</th>
          <th>Size</th>
          <th>Workers</th>
        </tr>
      </thead>
      <tbody>
        {#each groups as group (group.filename)}
          {@const artifact = bestArtifact(group)}
          {@const status = getConsensusStatus(group)}
          {#if artifact}
            <tr class="artifact-row" class:selected={selectedIds.has(artifact.eventId)}>
              <td class="col-check">
                <input
                  type="checkbox"
                  checked={selectedIds.has(artifact.eventId)}
                  onchange={() => onToggle(artifact.eventId)}
                  aria-label={`Select ${group.filename}`}
                />
              </td>
              <td class="col-filename">{group.filename}</td>
              <td class="col-consensus">
                <span class="status-badge {consensusClass(status)}">{consensusLabel(status)}</span>
              </td>
              <td class="col-hash" title={artifact.sha256}>{shortHash(artifact.sha256)}</td>
              <td class="col-size">{artifact.size != null ? formatBytes(artifact.size) : '—'}</td>
              <td class="col-workers">{workerCount(group)}</td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .empty {
    margin: 0;
    color: var(--ext-text-muted);
    font-size: 0.875rem;
    padding: 0.75rem 0;
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
    padding: 0.5rem 0.65rem;
    font-weight: 600;
    color: var(--ext-text-secondary);
    border-bottom: 1px solid var(--ext-border);
    white-space: nowrap;
  }

  .artifact-table td {
    padding: 0.5rem 0.65rem;
    border-bottom: 1px solid var(--ext-surface-2);
    color: var(--ext-text);
    vertical-align: middle;
  }

  .artifact-table tr:last-child td {
    border-bottom: none;
  }

  .artifact-row.selected {
    background: var(--ext-accent-soft-2);
  }

  .col-check {
    width: 2rem;
    text-align: center;
  }

  .col-filename {
    font-family: monospace;
    word-break: break-all;
  }

  .col-hash {
    font-family: monospace;
    color: var(--ext-text-muted);
    white-space: nowrap;
  }

  .col-size,
  .col-workers {
    white-space: nowrap;
    color: var(--ext-text-muted);
    text-align: right;
  }

  .status-badge {
    display: inline-block;
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .status-ok {
    background: var(--ext-success-bg);
    color: var(--ext-success-text);
  }

  .status-warn {
    background: var(--ext-warning-bg);
    color: var(--ext-warning-text);
  }

  .status-bad {
    background: var(--ext-danger-bg);
    color: var(--ext-danger-text);
  }
</style>
