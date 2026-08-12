import type { NostrEvent, RepoContext, WidgetBridge } from 'budabit-sdk';
import type {
  SoftwareRelease,
  SoftwareAsset,
  SoftwareApplication,
  ReleaseListItem,
  Artifact,
} from './types.js';
import { APP_KIND, RELEASE_KIND, ASSET_KIND } from './types.js';

export const FALLBACK_RELAYS = [
  'wss://relay.zapstore.dev', // where zapstore-published apps/releases live
  'wss://relay.sharegap.net',
  'wss://nos.lol',
];

/** Hosts cap extension subscriptions at 8 relays. */
const MAX_QUERY_RELAYS = 8;

export function getRelays(repoRelays: string[] | undefined): string[] {
  // The zapstore relay comes first — it's where zapstore-published apps,
  // releases, and assets actually live — followed by the repo's own relays,
  // then generic fallbacks. Capped to the host's per-subscription relay limit,
  // so with many repo relays the generic fallbacks are dropped first.
  const [zapstoreRelay, ...genericFallbacks] = FALLBACK_RELAYS;
  const merged = [zapstoreRelay, ...(repoRelays ?? []), ...genericFallbacks];
  return [...new Set(merged.filter(Boolean))].slice(0, MAX_QUERY_RELAYS);
}

// ── Release list cache (stale-while-revalidate) ─────────────────────────────

const LIST_CACHE_KEY = 'releases-list-cache-v1';
const LIST_CACHE_MAX_EVENTS = 50;

export interface CachedReleaseState {
  apps: SoftwareApplication[];
  events: NostrEvent[];
}

/**
 * Read the cached release list from host storage (repo-scoped).
 * Returns null when there is no cache, or when the widget lacks
 * storage permissions — callers just fall through to a live load.
 */
export async function loadCachedReleaseState(
  bridge: WidgetBridge
): Promise<CachedReleaseState | null> {
  try {
    const response = (await bridge.request('storage:get' as never, {
      key: LIST_CACHE_KEY,
      repoScoped: true,
    } as never)) as { data?: { apps?: unknown; events?: unknown } } | null;
    const data = response?.data;
    if (!data || !Array.isArray(data.events)) return null;
    return {
      apps: Array.isArray(data.apps) ? (data.apps as SoftwareApplication[]) : [],
      events: data.events as NostrEvent[],
    };
  } catch {
    return null;
  }
}

/**
 * Persist the release list to host storage (repo-scoped, best effort).
 * JSON round-trip strips Svelte reactive proxies so the payload is
 * structured-cloneable, and trimming keeps us under the host's 1MB cap.
 */
export async function saveCachedReleaseState(
  bridge: WidgetBridge,
  apps: SoftwareApplication[],
  events: NostrEvent[]
): Promise<void> {
  try {
    const trimmed = [...events]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, LIST_CACHE_MAX_EVENTS);
    const data = JSON.parse(JSON.stringify({ apps, events: trimmed, ts: Date.now() }));
    await bridge.request('storage:set' as never, {
      key: LIST_CACHE_KEY,
      repoScoped: true,
      data,
    } as never);
  } catch {
    // Best effort — cache misses are always recoverable via live load.
  }
}

export async function queryEvents(
  bridge: WidgetBridge,
  relays: string[],
  filter: Record<string, unknown>
): Promise<NostrEvent[]> {
  const response = await bridge.request('nostr:query', { relays, filter });
  if ('error' in response) throw new Error(response.error);
  return response.events ?? [];
}

export async function signEvent(
  bridge: WidgetBridge,
  unsignedEvent: Record<string, unknown>
): Promise<NostrEvent> {
  const response = (await bridge.request('nostr:sign', unsignedEvent)) as
    | { status: 'ok'; event: NostrEvent }
    | { error: string };
  if ('error' in response) throw new Error(response.error);
  if (response.status === 'ok' && response.event) return response.event;
  throw new Error('Unexpected response from nostr:sign');
}

export async function publishEvent(
  bridge: WidgetBridge,
  event: Record<string, unknown>,
  relays?: string[]
): Promise<string> {
  const payload = relays ? { event, relays } : event;
  const response = (await bridge.request('nostr:publish', payload)) as {
    error?: string;
    result?: { eventId?: string };
    eventId?: string;
  };
  if (response.error) throw new Error(response.error);
  return response.result?.eventId ?? response.eventId ?? '';
}

export function tagValue(event: NostrEvent, tagName: string): string | undefined {
  return event.tags.find((tag) => tag[0] === tagName)?.[1];
}

export function tagValues(event: NostrEvent, tagName: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === tagName)
    .map((tag) => tag[1])
    .filter((value): value is string => Boolean(value));
}

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
 * Does a 32267 application belong to this repo?
 * Zapstore-style apps link via a `repository` URL tag (github.com/owner/name);
 * NIP-82-style apps link via an `a` tag with the 30617 coordinate.
 */
export function appMatchesRepo(app: SoftwareApplication, repo: RepoContext): boolean {
  // Explicit coordinate link (NIP-34/82)
  if (app.repoAddress && repo.repoPubkey && app.repoAddress.includes(repo.repoPubkey)) {
    return true;
  }

  const name = (repo.repoName ?? '').toLowerCase();
  if (!name) return false;

  // Repository URL tail match (zapstore convention): .../owner/<name>
  const repoUrl = (app.repositoryUrl ?? '').toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  if (repoUrl && repoUrl.split('/').pop() === name) return true;

  // App display name matches repo name
  if (app.name && app.name.toLowerCase() === name) return true;

  return false;
}

/**
 * Find kind 32267 Software Application events that belong to this repo.
 * Two lookups run in parallel:
 *  - by `#a` coordinate (NIP-82 linkage), when the address is coordinate-form
 *  - by authors (repo owner + maintainers) — zapstore publishes apps signed by
 *    the developer's own key, linked to the repo only via a `repository` URL
 */
export async function loadRepoApps(
  bridge: WidgetBridge,
  repo: RepoContext
): Promise<SoftwareApplication[]> {
  const relays = getRelays(repo.repoRelays);

  const authors = [
    ...new Set([repo.repoPubkey, ...(repo.maintainers ?? [])].filter(Boolean)),
  ] as string[];

  const coordinate = repo.repoNaddr ?? '';
  const queries: Promise<NostrEvent[]>[] = [];

  if (coordinate.includes(':')) {
    queries.push(
      queryEvents(bridge, relays, {kinds: [APP_KIND], '#a': [coordinate]}).catch(() => [])
    );
  }
  if (authors.length > 0) {
    queries.push(
      queryEvents(bridge, relays, {kinds: [APP_KIND], authors}).catch(() => [])
    );
  }
  if (queries.length === 0) return [];

  const results = (await Promise.all(queries)).flat();

  // Dedupe by event id, parse, keep only apps belonging to this repo,
  // then keep the newest event per app identifier (32267 is addressable).
  const seen = new Set<string>();
  const byAppId = new Map<string, SoftwareApplication>();
  for (const event of results) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const app = parseApplication(event);
    if (!appMatchesRepo(app, repo)) continue;
    const existing = byAppId.get(app.appId);
    if (!existing || app.createdAt > existing.createdAt) {
      byAppId.set(app.appId, app);
    }
  }

  return [...byAppId.values()];
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
