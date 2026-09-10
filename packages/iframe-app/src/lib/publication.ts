import type { NostrEvent, WidgetBridge } from 'budabit-sdk';
import type { EventTemplate } from 'nostr-tools';
import { isMaintainer, normalizeContext, record, type RepoContext } from './context.js';
import { appCoordinate, authorizedRelease, verifiedEvent } from './trust.js';
import {
  buildApplicationEvent,
  buildAssetEvent,
  buildReleaseEvent,
  getRelays,
  loadRepoApps,
  tagValues,
} from './releases.js';
import type { Artifact } from './types.js';

export interface ReleaseDraft {
  appId: string;
  appPubkey: string;
  appName?: string;
  newApplication: boolean;
  version: string;
  channel: string;
  releaseNotes: string;
  artifacts: Artifact[];
}
export interface PublicationJournal {
  schema: 1;
  repoAddress: string;
  publisher: string;
  events: NostrEvent[];
  accepted: string[];
}
const JOURNAL_KEY = 'release-publication-v1';
const journalKey = (repo: RepoContext) => `${JOURNAL_KEY}:${repo.userPubkey}`;

export async function requestOk(
  bridge: WidgetBridge,
  action: string,
  payload: unknown
): Promise<Record<string, unknown>> {
  const response = record(await bridge.request(action, payload));
  if (typeof response.error === 'string') throw new Error(response.error);
  if (response.status !== 'ok') throw new Error(`Unexpected or incomplete ${action} response`);
  return response;
}

async function assertActive(bridge: WidgetBridge, repo: RepoContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const current = normalizeContext(await requestOk(bridge, 'context:getRepo', {}));
  signal?.throwIfAborted();
  if (
    !current ||
    current.repoAddress !== repo.repoAddress ||
    current.userPubkey !== repo.userPubkey ||
    JSON.stringify([...current.maintainers].sort()) !==
      JSON.stringify([...repo.maintainers].sort()) ||
    !isMaintainer(current)
  ) {
    throw new Error('Repository or signing account changed; publication stopped');
  }
}

const scope = (repo: RepoContext) => ({
  expectedRepoAddress: repo.repoAddress,
  expectedPubkey: repo.userPubkey,
});
const templateOf = (event: NostrEvent | EventTemplate) =>
  JSON.stringify([event.kind, event.created_at, event.tags, event.content]);

/** Sign every fixed template before the first publish. A lost signing response cannot publish anything. */
export async function preparePublication(
  bridge: WidgetBridge,
  repo: RepoContext,
  draft: ReleaseDraft,
  signal?: AbortSignal
): Promise<PublicationJournal> {
  const frozen = structuredClone(JSON.parse(JSON.stringify(draft)) as ReleaseDraft);
  if (!frozen.artifacts.length || frozen.artifacts.length > 50)
    throw new Error('Select between 1 and 50 artifacts');
  if (
    !repo.maintainers.includes(frozen.appPubkey) ||
    (frozen.newApplication && frozen.appPubkey !== repo.userPubkey)
  )
    throw new Error('Unauthorized application publisher');
  if (
    new Set(frozen.artifacts.map((a) => a.pipelineRunId)).size !== 1 ||
    !frozen.artifacts[0]?.pipelineRunId
  )
    throw new Error('Select artifacts from one authenticated run');
  const created_at = Math.floor(Date.now() / 1000);
  if (!frozen.newApplication) {
    await assertActive(bridge, repo, signal);
    const currentApps = await loadRepoApps(bridge, repo);
    if (
      !currentApps.some((app) => appCoordinate(app) === `32267:${frozen.appPubkey}:${frozen.appId}`)
    ) {
      throw new Error('Application repository linkage changed; rediscover before signing');
    }
  }
  const relays = getRelays(repo.repoRelays);
  const templates: Record<string, unknown>[] = [];
  if (frozen.newApplication)
    templates.push(
      buildApplicationEvent({
        appId: frozen.appId,
        name: frozen.appName || frozen.appId,
        repoAddress: repo.repoAddress,
        repoRelay: relays[0] ?? '',
      })
    );
  templates.push(
    ...frozen.artifacts.map((artifact) =>
      buildAssetEvent({ appId: frozen.appId, version: frozen.version, artifact })
    )
  );
  // Validate the release before requesting any signatures.
  const release = buildReleaseEvent({
    ...frozen,
    assetEventIds: [],
    relayHint: relays[0],
    platforms: frozen.artifacts.flatMap((a) => a.platforms ?? []),
  });
  const events: NostrEvent[] = [];
  for (let index = 0; index <= templates.length; index++) {
    const template =
      index === templates.length
        ? {
            ...release,
            tags: [
              ...(release.tags as string[][]),
              ...events.filter((e) => e.kind === 3063).map((e) => ['e', e.id, relays[0] ?? '']),
            ],
            created_at,
          }
        : { ...templates[index], created_at };
    await assertActive(bridge, repo, signal);
    const response = await requestOk(bridge, 'nostr:sign', { ...template, ...scope(repo) });
    signal?.throwIfAborted();
    const signed = verifiedEvent(response.event);
    if (
      !signed ||
      signed.pubkey !== repo.userPubkey ||
      templateOf(signed) !== templateOf(template as EventTemplate)
    ) {
      throw new Error('Signer returned a different event or publisher');
    }
    events.push(signed);
  }
  const journal: PublicationJournal = {
    schema: 1,
    repoAddress: repo.repoAddress,
    publisher: repo.userPubkey,
    events,
    accepted: [],
  };
  await saveJournal(bridge, repo, journal, signal);
  return journal;
}

async function saveJournal(
  bridge: WidgetBridge,
  repo: RepoContext,
  journal: PublicationJournal,
  signal?: AbortSignal
) {
  await assertActive(bridge, repo, signal);
  await requestOk(bridge, 'storage:set', {
    key: journalKey(repo),
    repoScoped: true,
    ...scope(repo),
    data: JSON.parse(JSON.stringify(journal)) as unknown,
  });
}

export async function loadJournal(
  bridge: WidgetBridge,
  repo: RepoContext,
  signal?: AbortSignal
): Promise<PublicationJournal | null> {
  const response = await requestOk(bridge, 'storage:get', {
    key: journalKey(repo),
    repoScoped: true,
    ...scope(repo),
  });
  if (response.data == null) return null;
  return validateJournal(bridge, repo, response.data, signal);
}

async function validateJournal(
  bridge: WidgetBridge,
  repo: RepoContext,
  input: unknown,
  signal?: AbortSignal
): Promise<PublicationJournal> {
  const value = record(input);
  if (
    value.schema !== 1 ||
    value.repoAddress !== repo.repoAddress ||
    value.publisher !== repo.userPubkey ||
    !Array.isArray(value.events) ||
    value.events.length < 2 ||
    value.events.length > 52
  )
    throw new Error('Stored publication belongs to another account or is invalid');
  const events = value.events.map(verifiedEvent);
  if (events.some((e) => !e || e.pubkey !== repo.userPubkey))
    throw new Error('Stored publication has invalid signatures');
  const verified = events as NostrEvent[];
  const release = verified.at(-1);
  if (!release) throw new Error('Stored publication is empty');
  const appEvents = verified.filter((e) => e.kind === 32267);
  await assertActive(bridge, repo, signal);
  const apps = await loadRepoApps(bridge, repo, appEvents);
  await assertActive(bridge, repo, signal);
  const assets = verified.filter((e) => e.kind === 3063);
  if (
    appEvents.length > 1 ||
    verified.filter((e) => e.kind === 30063).length !== 1 ||
    verified.some((e) => ![32267, 3063, 30063].includes(e.kind)) ||
    !authorizedRelease(release, repo, apps) ||
    JSON.stringify(tagValues(release, 'e')) !== JSON.stringify(assets.map((e) => e.id))
  )
    throw new Error('Stored publication has inconsistent asset/application links');
  return {
    schema: 1,
    repoAddress: repo.repoAddress,
    publisher: repo.userPubkey,
    events: verified,
    accepted: [],
  };
}

/** Retry the same signed event IDs, never re-sign. Resume deliberately republishes: local acks are not authoritative. */
export async function publishJournal(
  bridge: WidgetBridge,
  repo: RepoContext,
  journal: PublicationJournal,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<void> {
  if (journal.publisher !== repo.userPubkey || journal.repoAddress !== repo.repoAddress)
    throw new Error('Publication scope changed');
  // Always validate here as well as on restore: a same-session retry can outlive
  // an application revocation. Pin the independently verified batch across awaits.
  const current = await validateJournal(bridge, repo, journal, signal);
  journal.events = current.events;
  journal.accepted = [];
  for (const event of current.events) {
    await assertActive(bridge, repo, signal);
    onProgress?.(`Publishing ${journal.accepted.length + 1} of ${journal.events.length} events…`);
    const response = await requestOk(bridge, 'nostr:publish', {
      event,
      relays: getRelays(repo.repoRelays),
      ...scope(repo),
    });
    const result = record(response.result);
    if (
      result.eventId !== event.id ||
      typeof result.successCount !== 'number' ||
      result.successCount < 1
    ) {
      throw new Error('Publication acceptance is unknown; retry the saved signed events');
    }
    if (!journal.accepted.includes(event.id)) journal.accepted.push(event.id);
    await saveJournal(bridge, repo, journal, signal);
  }
  await discardJournal(bridge, repo, signal);
}

/** Delete only local recovery state, after explicit user confirmation in the UI. */
export async function discardJournal(
  bridge: WidgetBridge,
  repo: RepoContext,
  signal?: AbortSignal
) {
  await assertActive(bridge, repo, signal);
  await requestOk(bridge, 'storage:set', {
    key: journalKey(repo),
    repoScoped: true,
    ...scope(repo),
    data: null,
  });
}
