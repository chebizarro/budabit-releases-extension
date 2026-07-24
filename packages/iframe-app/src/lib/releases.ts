import type { WidgetBridge } from './bridge.js';
import type { RepoContext } from './types.js';
import type {
  SoftwareRelease,
  SoftwareAsset,
  SoftwareApplication,
  ReleaseListItem,
  Artifact,
  NostrEvent,
} from './types.js';
import { APP_KIND, RELEASE_KIND, ASSET_KIND } from './types.js';
import { queryEvents, signEvent, publishEvent, getRelays, tagValue, tagValues } from './bridge.js';

// ── Parsers ──────────────────────────────────────────────────────────────────

/**
 * Derive a display filename from a kind 3063 asset event.
 * Prefers: url basename → variant + MIME extension → sha256 truncation.
 */
function deriveFilename(event: NostrEvent): string {
  const url = tagValue(event, 'url');
  if (url) {
    try {
      const path = new URL(url).pathname;
      const basename = path.split('/').pop();
      if (basename && basename.length > 0 && basename !== '/') return basename;
    } catch {
      /* ignore */
    }
  }
  const variant = tagValue(event, 'variant');
  if (variant) return variant;
  const sha = tagValue(event, 'x');
  return sha ? sha.slice(0, 12) : 'asset';
}

export function parseAsset(event: NostrEvent): SoftwareAsset | null {
  const sha256 = tagValue(event, 'x');
  const mimeType = tagValue(event, 'm');
  if (!sha256 || !mimeType) return null;

  const sizeStr = tagValue(event, 'size');
  const vcStr = tagValue(event, 'version_code');

  return {
    eventId: event.id,
    pubkey: event.pubkey,
    appId: tagValue(event, 'i') ?? '',
    url: tagValue(event, 'url'),
    mimeType,
    sha256,
    size: sizeStr ? parseInt(sizeStr, 10) || undefined : undefined,
    version: tagValue(event, 'version') ?? '',
    platforms: tagValues(event, 'f'),
    minPlatformVersion: tagValue(event, 'min_platform_version'),
    targetPlatformVersion: tagValue(event, 'target_platform_version'),
    variant: tagValue(event, 'variant'),
    commitId: tagValue(event, 'commit'),
    minAllowedVersion: tagValue(event, 'min_allowed_version'),
    versionCode: vcStr ? parseInt(vcStr, 10) || undefined : undefined,
    apkCertificateHashes: tagValues(event, 'apk_certificate_hash'),
    filename: deriveFilename(event),
  };
}

export function parseReleaseListItem(event: NostrEvent): ReleaseListItem {
  return {
    id: event.id,
    pubkey: event.pubkey,
    appId: tagValue(event, 'i') ?? '',
    version: tagValue(event, 'version') ?? tagValue(event, 'd')?.split('@').pop() ?? 'unknown',
    channel: tagValue(event, 'c') ?? 'main',
    assetCount: event.tags.filter((t) => t[0] === 'e').length,
    createdAt: event.created_at,
  };
}

export function parseApplication(event: NostrEvent): SoftwareApplication {
  return {
    id: event.id,
    pubkey: event.pubkey,
    appId: tagValue(event, 'd') ?? '',
    name: tagValue(event, 'name') ?? tagValue(event, 'd') ?? '',
    summary: tagValue(event, 'summary'),
    description: event.content,
    iconUrl: tagValue(event, 'icon'),
    imageUrls: tagValues(event, 'image'),
    tags: tagValues(event, 't'),
    websiteUrl: tagValue(event, 'url'),
    repositoryUrl: tagValue(event, 'repository'),
    repoAddress: event.tags.find((t) => t[0] === 'a' && t[1]?.startsWith('30617:'))?.[1],
    platforms: tagValues(event, 'f'),
    license: tagValue(event, 'license'),
    createdAt: event.created_at,
  };
}

// ── Application discovery ────────────────────────────────────────────────────

/**
 * Find kind 32267 Software Application events that reference this repo
 * via an `a` tag pointing to its 30617 address.
 */
export async function loadRepoApps(
  bridge: WidgetBridge,
  repo: RepoContext
): Promise<SoftwareApplication[]> {
  const relays = getRelays(repo.repoRelays);
  const repoAddr = repo.repoNaddr ?? '';
  if (!repoAddr) return [];

  // Resolve the coordinate form: 30617:pubkey:identifier
  const coordinate = repoAddr;
  if (!coordinate.includes(':')) {
    // It's a bech32 naddr — we can't easily decode it in pure JS without nostr-tools.
    // Try querying by author instead.
    const pubkey = repo.repoPubkey;
    if (!pubkey) return [];
    const events = await queryEvents(bridge, relays, {
      kinds: [APP_KIND],
      authors: [pubkey],
    });
    return events
      .map(parseApplication)
      .filter((a) => a.repoAddress?.includes(pubkey));
  }

  const events = await queryEvents(bridge, relays, {
    kinds: [APP_KIND],
    '#a': [coordinate],
  });

  return events.map(parseApplication);
}

// ── Release data loading ─────────────────────────────────────────────────────

/**
 * Load full release detail: fetch linked kind 3063 asset events.
 */
export async function loadReleaseDetail(
  bridge: WidgetBridge,
  repo: RepoContext,
  releaseEvent: NostrEvent
): Promise<SoftwareRelease> {
  const relays = getRelays(repo.repoRelays);
  const appId = tagValue(releaseEvent, 'i') ?? '';
  const version =
    tagValue(releaseEvent, 'version') ??
    tagValue(releaseEvent, 'd')?.split('@').pop() ??
    'unknown';
  const dTag = tagValue(releaseEvent, 'd') ?? `${appId}@${version}`;
  const channel = tagValue(releaseEvent, 'c') ?? 'main';
  const assetEventIds = releaseEvent.tags
    .filter((tag) => tag[0] === 'e')
    .map((tag) => tag[1])
    .filter((id): id is string => Boolean(id));

  let assets: SoftwareAsset[] = [];
  if (assetEventIds.length > 0) {
    const events = await queryEvents(bridge, relays, {
      kinds: [ASSET_KIND],
      ids: assetEventIds,
    });
    assets = events.map(parseAsset).filter((a): a is SoftwareAsset => a !== null);
    // Preserve declaration order from the release event
    const byId = new Map(assets.map((a) => [a.eventId, a]));
    assets = assetEventIds.map((id) => byId.get(id)).filter((a): a is SoftwareAsset => !!a);
  }

  return {
    id: releaseEvent.id,
    pubkey: releaseEvent.pubkey,
    appId,
    version,
    dTag,
    channel,
    releaseNotes: releaseEvent.content,
    assetEventIds,
    assets,
    createdAt: releaseEvent.created_at,
  };
}

// ── Event builders ───────────────────────────────────────────────────────────

/**
 * Build an unsigned kind 32267 Software Application event.
 */
export function buildApplicationEvent(opts: {
  appId: string;
  name: string;
  description?: string;
  summary?: string;
  repoAddress: string; // 30617:pubkey:identifier
  repoRelay: string;
  repositoryUrl?: string;
  license?: string;
}): Record<string, unknown> {
  const tags: string[][] = [
    ['d', opts.appId],
    ['name', opts.name],
    ['a', opts.repoAddress, opts.repoRelay],
  ];
  if (opts.summary) tags.push(['summary', opts.summary]);
  if (opts.repositoryUrl) tags.push(['repository', opts.repositoryUrl]);
  if (opts.license) tags.push(['license', opts.license]);

  return {
    kind: APP_KIND,
    content: opts.description ?? '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Build an unsigned kind 3063 Software Asset event from a pipeline artifact.
 */
export function buildAssetEvent(opts: {
  appId: string;
  version: string;
  artifact: Artifact;
  platforms?: string[];
  commitId?: string;
  variant?: string;
}): Record<string, unknown> {
  const tags: string[][] = [
    ['i', opts.appId],
    ['version', opts.version],
    ['m', opts.artifact.mimeType],
    ['x', opts.artifact.sha256],
  ];
  if (opts.artifact.url) tags.push(['url', opts.artifact.url]);
  if (opts.artifact.size != null) tags.push(['size', String(opts.artifact.size)]);
  if (opts.platforms) {
    for (const p of opts.platforms) tags.push(['f', p]);
  }
  const commitId = opts.commitId ?? opts.artifact.commitId;
  if (commitId) tags.push(['commit', commitId]);
  if (opts.variant) tags.push(['variant', opts.variant]);

  return {
    kind: ASSET_KIND,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Build an unsigned kind 30063 Software Release event (NIP-82 compliant).
 */
export function buildReleaseEvent(opts: {
  appId: string;
  version: string;
  channel: string;
  assetEventIds: string[];
  releaseNotes: string;
  relayHint?: string;
}): Record<string, unknown> {
  const tags: string[][] = [
    ['d', `${opts.appId}@${opts.version}`],
    ['i', opts.appId],
    ['version', opts.version],
    ['c', opts.channel],
    ...opts.assetEventIds.map((id) => ['e', id, opts.relayHint ?? '']),
  ];

  return {
    kind: RELEASE_KIND,
    content: opts.releaseNotes,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Full release creation flow:
 * 1. Sign + publish kind 3063 asset events for each selected artifact
 * 2. Publish kind 30063 release event referencing the asset event IDs
 *
 * Returns the published release event ID.
 */
export async function createRelease(
  bridge: WidgetBridge,
  relays: string[],
  opts: {
    appId: string;
    version: string;
    channel: string;
    releaseNotes: string;
    artifacts: Artifact[];
    platforms?: string[];
    commitId?: string;
  }
): Promise<string> {
  // Phase 1: Publish kind 3063 asset events
  const assetEventIds: string[] = [];
  for (const artifact of opts.artifacts) {
    const unsigned = buildAssetEvent({
      appId: opts.appId,
      version: opts.version,
      artifact,
      platforms: opts.platforms,
      commitId: opts.commitId,
    });
    const signed = await signEvent(bridge, unsigned);
    const eventId = await publishEvent(bridge, { event: signed, relays });
    assetEventIds.push(eventId || signed.id);
  }

  // Phase 2: Publish kind 30063 release event
  const releaseUnsigned = buildReleaseEvent({
    appId: opts.appId,
    version: opts.version,
    channel: opts.channel,
    assetEventIds,
    releaseNotes: opts.releaseNotes,
    relayHint: relays[0],
  });

  const releaseSigned = await signEvent(bridge, releaseUnsigned);
  const releaseId = await publishEvent(bridge, { event: releaseSigned, relays });
  return releaseId || releaseSigned.id;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

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

/** Resolve a blossom download URL for an asset (by SHA-256 if no URL tag). */
export function assetDownloadUrl(asset: SoftwareAsset, blossomServer?: string): string {
  if (asset.url) return asset.url;
  const server = blossomServer ?? 'https://blossom.primal.net';
  return `${server}/${asset.sha256}`;
}

/** Human-readable platform label from f-tag identifiers. */
export function platformLabel(platforms: string[]): string {
  if (platforms.length === 0) return 'Universal';
  return platforms
    .map((p) => {
      const parts = p.split('-');
      const os = parts[0] ?? p;
      const arch = parts.slice(1).join('-');
      return arch ? `${os} (${arch})` : os;
    })
    .join(', ');
}
