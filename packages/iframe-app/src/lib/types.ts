// ── Nostr primitives ────────────────────────────────────────────────────────

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// ── NIP-94 kind 1063 artifact ────────────────────────────────────────────────

export interface Artifact {
  eventId: string;
  url: string;       // blossom URL (url tag)
  sha256: string;    // x tag
  filename: string;  // filename tag
  mimeType: string;  // m tag
  size?: number;     // size tag (bytes)
  // enriched from pipeline run context
  pipelineRunId?: string;
  workflowName?: string;
  branch?: string;
  commitId?: string;
}

// ── NIP-51 kind 30063 release artifact set ───────────────────────────────────

export interface Release {
  id: string;
  pubkey: string;
  version: string;       // d tag
  repoNaddr: string;     // a tag (30617:...)
  releaseNotes: string;  // content
  artifactIds: string[]; // e tag ids (order preserved)
  artifacts: Artifact[];
  commitId?: string;     // r tag
  createdAt: number;
}

export interface ReleaseListItem {
  id: string;
  pubkey: string;
  version: string;
  artifactCount: number;
  createdAt: number;
}

// ── kind 5401 workflow run ───────────────────────────────────────────────────

export interface PipelineRun {
  id: string;
  workflowName: string;
  branch: string;
  commitId: string;
  createdAt: number;
  ephemeralPubkey: string; // publisher tag
  triggeredBy: string;     // triggered-by tag
}

// ── Artifact grouping (consensus across workers) ─────────────────────────────

export interface ArtifactGroup {
  filename: string;
  sha256Counts: Map<string, Artifact[]>; // sha256 → artifacts with that hash
  consensusHash: string | null;
  isUnanimous: boolean;
}

export type ConsensusStatus = 'unanimous' | 'majority' | 'split';

export function getConsensusStatus(group: ArtifactGroup): ConsensusStatus {
  if (group.isUnanimous) return 'unanimous';
  if (!group.consensusHash) return 'split';
  const top = group.sha256Counts.get(group.consensusHash)?.length ?? 0;
  const total = [...group.sha256Counts.values()].reduce((s, a) => s + a.length, 0);
  return top / total > 0.5 ? 'majority' : 'split';
}
