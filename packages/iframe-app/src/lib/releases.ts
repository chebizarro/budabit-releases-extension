import type { WidgetBridge, RepoContext } from 'budabit-sdk';
import type { Release, ReleaseListItem, Artifact, NostrEvent } from './types.js';
import { queryEvents, getRelays, tagValue } from './bridge.js';

const RELEASE_KIND = 30063;
const ARTIFACT_KIND = 1063;

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseArtifact(event: NostrEvent): Artifact | null {
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
  };
}

export function parseReleaseListItem(event: NostrEvent): ReleaseListItem {
  return {
    id: event.id,
    pubkey: event.pubkey,
    version: tagValue(event, 'd') ?? 'unknown',
    artifactCount: event.tags.filter((t) => t[0] === 'e').length,
    createdAt: event.created_at,
  };
}

// ── Data loading ─────────────────────────────────────────────────────────────

/**
 * Load full release detail: fetch linked kind 1063 artifact events.
 */
export async function loadReleaseDetail(
  bridge: WidgetBridge,
  repo: RepoContext,
  releaseEvent: NostrEvent
): Promise<Release> {
  const relays = getRelays(repo.repoRelays);
  const version = tagValue(releaseEvent, 'd') ?? 'unknown';
  const repoNaddr =
    releaseEvent.tags.find((t) => t[0] === 'a')?.[1] ?? repo.repoNaddr ?? '';
  const artifactIds = releaseEvent.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
  const commitId = tagValue(releaseEvent, 'r');

  let artifacts: Artifact[] = [];
  if (artifactIds.length > 0) {
    const events = await queryEvents(bridge, relays, {
      kinds: [ARTIFACT_KIND],
      ids: artifactIds,
    });
    artifacts = events.map(parseArtifact).filter((a): a is Artifact => a !== null);
    // Preserve order declared by the release event
    const byId = new Map(artifacts.map((a) => [a.eventId, a]));
    artifacts = artifactIds.map((id) => byId.get(id)).filter((a): a is Artifact => !!a);
  }

  return {
    id: releaseEvent.id,
    pubkey: releaseEvent.pubkey,
    version,
    repoNaddr,
    releaseNotes: releaseEvent.content,
    artifactIds,
    artifacts,
    commitId,
    createdAt: releaseEvent.created_at,
  };
}

// ── Event builder ─────────────────────────────────────────────────────────────

/**
 * Build an unsigned kind 30063 event ready to pass to nostr:publish.
 */
export function buildReleaseEvent(opts: {
  version: string;
  repoNaddr: string;
  repoRelay: string;
  artifactEventIds: string[];
  releaseNotes: string;
  commitId?: string;
}): Record<string, unknown> {
  const tags: string[][] = [
    ['d', opts.version],
    ['a', opts.repoNaddr, opts.repoRelay],
    ...opts.artifactEventIds.map((id) => ['e', id]),
    ['t', opts.version],
  ];
  if (opts.commitId) tags.push(['r', opts.commitId]);

  return {
    kind: RELEASE_KIND,
    content: opts.releaseNotes,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(unixTs: number): string {
  return new Date(unixTs * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12) + '…';
}
