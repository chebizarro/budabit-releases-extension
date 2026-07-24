import type { NostrEvent, RepoContext, WidgetBridge } from 'budabit-sdk';
import type { Artifact, PipelineRun, ArtifactGroup } from './types.js';
import { queryEvents, getRelays, tagValue } from './releases.js';

const RUN_KIND = 5401;
const ARTIFACT_KIND = 1063;

// ── Types ────────────────────────────────────────────────────────────────────

export interface PipelineArtifactData {
  runs: PipelineRun[];
  artifactsByRun: Map<string, Artifact[]>;
  allArtifacts: Artifact[];
  groups: ArtifactGroup[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseArtifactWithContext(event: NostrEvent, run: PipelineRun): Artifact | null {
  const url = tagValue(event, 'url');
  const sha256 = tagValue(event, 'x');
  if (!url || !sha256) return null;
  const sizeStr = tagValue(event, 'size');
  return {
    eventId: event.id,
    url,
    sha256,
    filename: tagValue(event, 'filename') ?? tagValue(event, 'name') ?? 'unknown',
    mimeType: tagValue(event, 'm') ?? 'application/octet-stream',
    size: sizeStr ? parseInt(sizeStr, 10) || undefined : undefined,
    pipelineRunId: run.id,
    workflowName: run.workflowName,
    branch: run.branch,
    commitId: run.commitId || undefined,
  };
}

function buildArtifactGroups(artifacts: Artifact[]): ArtifactGroup[] {
  const byFilename = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    const list = byFilename.get(a.filename) ?? [];
    list.push(a);
    byFilename.set(a.filename, list);
  }

  return Array.from(byFilename.entries()).map(([filename, arts]) => {
    const sha256Counts = new Map<string, Artifact[]>();
    for (const a of arts) {
      const list = sha256Counts.get(a.sha256) ?? [];
      list.push(a);
      sha256Counts.set(a.sha256, list);
    }
    const sorted = [...sha256Counts.entries()].sort((a, b) => b[1].length - a[1].length);
    const consensusHash = sorted[0]?.[0] ?? null;
    return { filename, sha256Counts, consensusHash, isUnanimous: sorted.length === 1 };
  });
}

// ── Main loader ──────────────────────────────────────────────────────────────

/**
 * Two-phase load:
 *   1. Fetch kind 5401 workflow runs for the repo
 *   2. Fetch kind 1063 artifacts from trusted ephemeral publisher keys
 *
 * Only includes runs where `triggered-by` is in trustedMaintainers.
 */
export async function loadPipelineArtifacts(
  bridge: WidgetBridge,
  repo: RepoContext,
  trustedMaintainers: string[]
): Promise<PipelineArtifactData> {
  const relays = getRelays(repo.repoRelays);
  const trustedSet = new Set(trustedMaintainers);
  const empty: PipelineArtifactData = {
    runs: [],
    artifactsByRun: new Map(),
    allArtifacts: [],
    groups: [],
  };

  if (!repo.repoNaddr || trustedSet.size === 0) return empty;

  // Phase 1: load workflow runs
  const runEvents = await queryEvents(bridge, relays, {
    kinds: [RUN_KIND],
    '#a': [repo.repoNaddr],
  });

  // Build trusted run map
  const ephemeralToRun = new Map<string, PipelineRun>();
  const runById = new Map<string, PipelineRun>();

  for (const event of runEvents) {
    const triggeredBy = tagValue(event, 'triggered-by');
    const publisher = tagValue(event, 'publisher');
    if (!triggeredBy || !trustedSet.has(triggeredBy) || !publisher) continue;

    const run: PipelineRun = {
      id: event.id,
      workflowName:
        tagValue(event, 'workflow') ?? tagValue(event, 'name') ?? 'workflow',
      branch: tagValue(event, 'branch') ?? 'unknown',
      commitId: tagValue(event, 'commit') ?? tagValue(event, 'r') ?? '',
      createdAt: event.created_at,
      ephemeralPubkey: publisher,
      triggeredBy,
    };

    ephemeralToRun.set(publisher, run);
    runById.set(event.id, run);
  }

  if (ephemeralToRun.size === 0) return empty;

  const runs = [...new Set(ephemeralToRun.values())];
  const ephemeralPubkeys = Array.from(ephemeralToRun.keys());
  const runIds = Array.from(runById.keys());

  // Phase 2: fetch 1063 artifacts (two filter approaches for coverage)
  const seen = new Set<string>();
  const allArtifactEvents: NostrEvent[] = [];

  const addEvents = (events: NostrEvent[]) => {
    for (const e of events) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        allArtifactEvents.push(e);
      }
    }
  };

  if (ephemeralPubkeys.length > 0) {
    addEvents(
      await queryEvents(bridge, relays, {
        kinds: [ARTIFACT_KIND],
        authors: ephemeralPubkeys,
      })
    );
  }
  if (runIds.length > 0) {
    addEvents(
      await queryEvents(bridge, relays, {
        kinds: [ARTIFACT_KIND],
        '#e': runIds,
      })
    );
  }

  // Resolve each artifact to its run
  const artifactsByRun = new Map<string, Artifact[]>();
  const allArtifacts: Artifact[] = [];

  for (const event of allArtifactEvents) {
    const run = ephemeralToRun.get(event.pubkey);
    if (!run) continue;
    const artifact = parseArtifactWithContext(event, run);
    if (!artifact) continue;
    allArtifacts.push(artifact);
    const list = artifactsByRun.get(run.id) ?? [];
    list.push(artifact);
    artifactsByRun.set(run.id, list);
  }

  runs.sort((a, b) => b.createdAt - a.createdAt);

  return { runs, artifactsByRun, allArtifacts, groups: buildArtifactGroups(allArtifacts) };
}
