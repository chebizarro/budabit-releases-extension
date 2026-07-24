import { z } from 'zod';

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

// ── Budabit widget bridge protocol ──────────────────────────────────────────

export type UnsignedEvent = {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey?: string;
};

export const UnsignedEventSchema = z.object({
  kind: z.number(),
  content: z.string(),
  tags: z.array(z.array(z.string())),
  created_at: z.number(),
  pubkey: z.string().optional(),
});

export type RepoContext = {
  repoPubkey: string;
  repoName: string;
  repoNaddr?: string;
  repoRelays: string[];
  maintainers?: string[];
};

/** Runtime shape currently emitted by context:repoUpdate and context:getRepo. */
export type HostRepoContext = {
  pubkey: string;
  name: string;
  naddr?: string;
  relays: string[];
  address?: string;
  maintainers?: string[];
};

export type WidgetInitPayload = {
  pubkey?: string;
  relays?: string[];
  hostVersion?: string;
  extensionId?: string;
  repo?: RepoContext;
  repoContext?: RepoContext | HostRepoContext;
  [key: string]: unknown;
};

/** @deprecated Use WidgetInitPayload. Retained only for the v1 context:update fallback. */
export type WidgetContext = {
  contextId?: string;
  userPubkey?: string;
  relays?: string[];
  repo?: RepoContext | HostRepoContext;
  [key: string]: unknown;
};

export const WidgetContextSchema = z
  .object({
    contextId: z.string().optional(),
    userPubkey: z.string().optional(),
    relays: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());

export type BridgeError = { error: string };
export type NostrPublishResponse = { status: 'ok'; result?: unknown } | BridgeError;
export type NostrQueryResponse =
  | { status: 'ok'; events: NostrEvent[] }
  | { status: 'timeout'; events: NostrEvent[] }
  | BridgeError;
export type NostrSubscribeResponse =
  | { status: 'ok'; subscriptionId: string }
  | BridgeError;
export type NostrSubscriptionEvent = { subscriptionId: string; event: NostrEvent };
export type NostrSubscriptionEose = { subscriptionId: string; relay?: string };
export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface WidgetActionMap {
  'nostr:publish': { req: UnsignedEvent; res: NostrPublishResponse };
  'nostr:query': {
    req: { relays: string[]; filter: Record<string, unknown> };
    res: NostrQueryResponse;
  };
  'nostr:sign': {
    req: UnsignedEvent;
    res: { status: 'ok'; event: NostrEvent } | BridgeError;
  };
  'nostr:nip44Encrypt': {
    req: { recipientPubkey: string; plaintext: string };
    res: { status: 'ok'; ciphertext: string } | BridgeError;
  };
  'nostr:subscribe': {
    req: { subscriptionId: string; relays: string[]; filter: Record<string, unknown> };
    res: NostrSubscribeResponse;
  };
  'nostr:unsubscribe': {
    req: { subscriptionId: string };
    res: { status: 'ok' } | BridgeError;
  };
  'storage:get': {
    req: { key: string };
    res: { status: 'ok'; value: unknown } | BridgeError;
  };
  'storage:set': {
    req: { key: string; value: unknown };
    res: { status: 'ok' } | BridgeError;
  };
  'storage:remove': {
    req: { key: string };
    res: { status: 'ok' } | BridgeError;
  };
  'storage:keys': {
    req: Record<string, never>;
    res: { status: 'ok'; keys: string[] } | BridgeError;
  };
  'context:getRepo': {
    req: Record<string, never>;
    res: { status: 'ok'; repo: RepoContext | HostRepoContext | null } | BridgeError;
  };
  'ui:toast': {
    req: { message: string; type?: ToastType };
    res: { status: 'ok' } | BridgeError;
  };
  'ui:resize': {
    req: { height?: number; width?: number };
    res: { status: 'ok' } | BridgeError;
  };
  'ui:navigate': {
    req: { path: string };
    res: { status: 'ok' } | BridgeError;
  };
  'widget:init': { event: WidgetInitPayload };
  'widget:mounted': { event: { timestamp: number } };
  'widget:unmounting': { event: { timestamp: number } };
  'widget:ready': { event: { timestamp: number } };
  'context:repoUpdate': { event: RepoContext | HostRepoContext | null };
  /** @deprecated Legacy v1 fallback; remove when host v2 support is required. */
  'context:update': { event: WidgetContext };
  'nostr:subscription:event': { event: NostrSubscriptionEvent };
  /** @deprecated Legacy subscription event alias. */
  'nostr:event': { event: NostrSubscriptionEvent };
  'nostr:eose': { event: NostrSubscriptionEose };
}

export type WidgetAction = keyof WidgetActionMap;
export type WidgetRequestAction = {
  [K in WidgetAction]: 'req' extends keyof WidgetActionMap[K] ? K : never;
}[WidgetAction];
export type WidgetResponseAction = {
  [K in WidgetAction]: 'res' extends keyof WidgetActionMap[K] ? K : never;
}[WidgetAction];
export type WidgetEventAction = {
  [K in WidgetAction]: 'event' extends keyof WidgetActionMap[K] ? K : never;
}[WidgetAction];

export type WidgetRequestMessage<A extends WidgetRequestAction = WidgetRequestAction> = {
  type: 'request';
  id: string;
  action: A;
  payload?: WidgetActionMap[A]['req'];
};
export type WidgetResponseMessage<A extends WidgetResponseAction = WidgetResponseAction> = {
  type: 'response';
  id: string;
  action: A;
  payload?: WidgetActionMap[A]['res'];
};
export type WidgetEventMessage<A extends WidgetEventAction = WidgetEventAction> = {
  type: 'event';
  action: A;
  payload?: WidgetActionMap[A]['event'];
};
export type WidgetUnknownMessage =
  | { type: 'request' | 'response'; id: string; action: string; payload?: unknown }
  | { type: 'event'; action: string; payload?: unknown; id?: never };
export type WidgetWireMessage =
  | WidgetRequestMessage
  | WidgetResponseMessage
  | WidgetEventMessage
  | WidgetUnknownMessage;

export const WidgetRequestMessageSchema = z.object({
  type: z.literal('request'),
  id: z.string(),
  action: z.string(),
  payload: z.unknown().optional(),
});
export const WidgetResponseMessageSchema = z.object({
  type: z.literal('response'),
  id: z.string(),
  action: z.string(),
  payload: z.unknown().optional(),
});
export const WidgetEventMessageSchema = z.object({
  type: z.literal('event'),
  action: z.string(),
  payload: z.unknown().optional(),
});
export const WidgetWireMessageSchema = z.union([
  WidgetRequestMessageSchema,
  WidgetResponseMessageSchema,
  WidgetEventMessageSchema,
]);

// ── NIP-82 Constants ─────────────────────────────────────────────────────────

export const APP_KIND = 32267;
export const RELEASE_KIND = 30063;
export const ASSET_KIND = 3063;

/** Legacy kind used by loom pipeline artifact uploads */
export const LEGACY_ARTIFACT_KIND = 1063;

/** Standard release channels (NIP-82 Appendix B) */
export const CHANNELS = ['main', 'beta', 'nightly', 'dev'] as const;
export type Channel = (typeof CHANNELS)[number] | string;

/** Platform identifiers (NIP-82 Appendix A) */
export const PLATFORMS = [
  'android-arm64-v8a',
  'android-armeabi-v7a',
  'android-x86',
  'android-x86_64',
  'darwin-arm64',
  'darwin-x86_64',
  'linux-aarch64',
  'linux-x86_64',
  'linux-armv7l',
  'linux-riscv64',
  'windows-aarch64',
  'windows-x86_64',
  'ios-arm64',
  'freebsd-x86_64',
  'freebsd-aarch64',
  'wasm32',
  'wasm64',
  'wasi-wasm32',
  'wasi-wasm64',
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** NIP-82 Appendix C: Supported MIME types → platform + common extension */
export const MIME_TYPES: Record<string, { platform: string; extension: string }> = {
  'application/vnd.android.package-archive': { platform: 'Android', extension: '.apk' },
  'application/vnd.apple.ipa': { platform: 'iOS', extension: '.ipa' },
  'application/x-apple-diskimage': { platform: 'macOS', extension: '.dmg' },
  'application/vnd.apple.installer+xml': { platform: 'macOS', extension: '.pkg' },
  'application/x-msi': { platform: 'Windows', extension: '.msi' },
  'application/vnd.appimage': { platform: 'Linux', extension: '.AppImage' },
  'application/vnd.flatpak': { platform: 'Linux (Flatpak)', extension: '.flatpak' },
  'application/vnd.oci.image.manifest.v1+json': { platform: 'OCI', extension: '' },
  'application/x-executable': { platform: 'Linux (ELF)', extension: '' },
  'application/x-mach-binary': { platform: 'macOS (Mach-O)', extension: '' },
  'application/vnd.microsoft.portable-executable': { platform: 'Windows (PE)', extension: '.exe' },
  'application/vsix': { platform: 'VS Code', extension: '.vsix' },
  'application/x-chrome-extension': { platform: 'Chrome', extension: '.crx' },
  'application/x-xpinstall': { platform: 'Firefox', extension: '.xpi' },
  'application/wasm': { platform: 'Browser/WASI', extension: '.wasm' },
  'application/webbundle': { platform: 'Browser (PWA)', extension: '.wbn' },
};

// ── NIP-82 kind 32267: Software Application ──────────────────────────────────

export interface SoftwareApplication {
  id: string;
  pubkey: string;
  appId: string; // d tag (reverse-domain identifier)
  name: string; // name tag
  summary?: string; // summary tag
  description: string; // content (markdown)
  iconUrl?: string; // icon tag
  imageUrls: string[]; // image tags
  tags: string[]; // t tags
  websiteUrl?: string; // url tag
  repositoryUrl?: string; // repository tag
  repoAddress?: string; // a tag (30617:pubkey:name)
  platforms: string[]; // f tags
  license?: string; // license tag
  createdAt: number;
}

// ── NIP-82 kind 3063: Software Asset ─────────────────────────────────────────

export interface SoftwareAsset {
  eventId: string;
  pubkey: string;
  appId: string; // i tag
  url?: string; // url tag (blossom URL)
  mimeType: string; // m tag
  sha256: string; // x tag
  size?: number; // size tag
  version: string; // version tag
  platforms: string[]; // f tags
  minPlatformVersion?: string;
  targetPlatformVersion?: string;
  variant?: string; // variant tag
  commitId?: string; // commit tag
  minAllowedVersion?: string;
  // Android-specific
  versionCode?: number;
  apkCertificateHashes: string[];
  // Display helpers
  filename: string; // derived from url basename or variant
}

// ── NIP-82 kind 30063: Software Release ──────────────────────────────────────

export interface SoftwareRelease {
  id: string;
  pubkey: string;
  appId: string; // i tag
  version: string; // version tag
  dTag: string; // d tag (<appId>@<version>)
  channel: string; // c tag
  releaseNotes: string; // content (markdown)
  assetEventIds: string[]; // e tag ids (order preserved)
  assets: SoftwareAsset[];
  createdAt: number;
}

export interface ReleaseListItem {
  id: string;
  pubkey: string;
  appId: string;
  version: string;
  channel: string;
  assetCount: number;
  createdAt: number;
}

// ── Pipeline artifacts (kind 1063 from loom workers) ─────────────────────────
// These are the raw build outputs before being wrapped into NIP-82 kind 3063
// asset events during release creation.

export interface Artifact {
  eventId: string;
  url: string; // url tag (blossom URL)
  sha256: string; // x tag
  filename: string; // filename or name tag
  mimeType: string; // m tag
  size?: number; // size tag (bytes)
  // Enriched from pipeline run context
  pipelineRunId?: string;
  workflowName?: string;
  branch?: string;
  commitId?: string;
}

// ── kind 5401 workflow run ───────────────────────────────────────────────────

export interface PipelineRun {
  id: string;
  workflowName: string;
  branch: string;
  commitId: string;
  createdAt: number;
  ephemeralPubkey: string; // publisher tag
  triggeredBy: string; // triggered-by tag
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
