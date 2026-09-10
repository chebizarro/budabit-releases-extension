import { describe, expect, it } from 'vitest';
import type { NostrEvent, WidgetBridge } from 'budabit-sdk';
import type { EventTemplate } from 'nostr-tools';
import {
  preparePublication,
  publishJournal,
  loadJournal,
  requestOk,
  type ReleaseDraft,
} from './publication.js';
import { buildAssetEvent, tagValue, tagValues } from './releases.js';
import { signed, testPubkey, testRepo } from './test-fixtures.js';
import { record } from './context.js';

const draft = (): ReleaseDraft => ({
  appId: 'app',
  appPubkey: testPubkey(),
  newApplication: true,
  version: '1',
  channel: 'beta',
  releaseNotes: 'notes',
  artifacts: [
    {
      eventId: 'artifact',
      pipelineRunId: 'run',
      filename: 'file',
      url: 'https://files.example/file',
      sha256: 'a'.repeat(64),
      mimeType: 'application/octet-stream',
      appId: 'independent.asset',
      version: '2',
      platforms: ['linux-x86_64'],
      commitId: 'c'.repeat(40),
    },
  ],
});
function host() {
  let stored: unknown = null;
  const calls: string[] = [],
    published: string[] = [];
  let viewer = testPubkey(),
    signer = 1,
    failPublish = false;
  const b = {
    request: async (action: string, raw: unknown) => {
      calls.push(action);
      const payload = record(raw);
      if (action === 'context:getRepo')
        return { status: 'ok', repoContext: { ...testRepo(), userPubkey: viewer } };
      if (action === 'nostr:sign')
        return { status: 'ok', event: signed(payload as unknown as EventTemplate, signer) };
      if (action === 'storage:get') return { status: 'ok', data: stored };
      if (action === 'storage:set') {
        stored = structuredClone(payload.data);
        return { status: 'ok' };
      }
      if (action === 'nostr:query') return { status: 'ok', complete: true, events: [signed()] };
      if (action === 'nostr:publish') {
        const event = payload.event as NostrEvent;
        published.push(event.id);
        if (failPublish) throw new Error('timed out');
        return { status: 'ok', result: { eventId: event.id, successCount: 1 } };
      }
      throw new Error(action);
    },
  } as unknown as WidgetBridge;
  return {
    b,
    calls,
    published,
    setStored: (v: unknown) => (stored = v),
    setViewer: (v: string) => (viewer = v),
    setSigner: (v: number) => (signer = v),
    fail: (v: boolean) => (failPublish = v),
  };
}

describe('NIP-82 publication', () => {
  it('rechecks application linkage before signatures when creation outlives list discovery', async () => {
    const h = host();
    await expect(
      preparePublication(h.b, testRepo(), { ...draft(), newApplication: false, appId: 'revoked' })
    ).rejects.toThrow('linkage changed');
    expect(h.calls).not.toContain('nostr:sign');
    expect(h.published).toEqual([]);
  });
  it('fails closed on invalid drafts, aborts and malformed bridge responses', async () => {
    const h = host();
    await expect(
      preparePublication(h.b, testRepo(), { ...draft(), artifacts: [] })
    ).rejects.toThrow('between');
    await expect(
      preparePublication(h.b, testRepo(), { ...draft(), appPubkey: testPubkey(2) })
    ).rejects.toThrow('Unauthorized');
    const mixed = draft();
    mixed.artifacts.push({ ...mixed.artifacts[0]!, pipelineRunId: 'other' });
    await expect(preparePublication(h.b, testRepo(), mixed)).rejects.toThrow(
      'one authenticated run'
    );
    const controller = new AbortController();
    controller.abort();
    await expect(preparePublication(h.b, testRepo(), draft(), controller.signal)).rejects.toThrow();
    for (const response of [{ error: 'denied' }, { status: 'partial' }]) {
      await expect(
        requestOk({ request: async () => response } as unknown as WidgetBridge, 'nostr:sign', {})
      ).rejects.toThrow();
    }
    expect(h.published).toHaveLength(0);
  });
  it('reverifies stored signatures, namespace and linked event set before resume', async () => {
    const h = host(),
      journal = await preparePublication(h.b, testRepo(), draft());
    h.setStored({ ...journal, publisher: testPubkey(2) });
    await expect(loadJournal(h.b, testRepo())).rejects.toThrow('another account');
    h.setStored({ ...journal, events: journal.events.map((e) => ({ ...e, content: 'tampered' })) });
    await expect(loadJournal(h.b, testRepo())).rejects.toThrow('invalid signatures');
    h.setStored({ ...journal, events: journal.events.filter((e) => e.kind !== 3063) });
    await expect(loadJournal(h.b, testRepo())).rejects.toThrow('inconsistent');
    await expect(
      publishJournal(h.b, testRepo(), { ...journal, repoAddress: 'other' })
    ).rejects.toThrow('scope changed');
    const existing = await preparePublication(h.b, testRepo(), {
      ...draft(),
      newApplication: false,
    });
    expect(existing.events).toHaveLength(2);
    expect(await loadJournal(h.b, testRepo())).toMatchObject({ events: existing.events });
  });
  it('signs and persists all templates before any publish; preserves independent asset metadata', async () => {
    const h = host();
    const journal = await preparePublication(h.b, testRepo(), draft());
    expect(h.published).toEqual([]);
    expect(journal.events.map((e) => e.kind)).toEqual([32267, 3063, 30063]);
    const asset = journal.events[1]!,
      release = journal.events[2]!;
    expect(tagValue(asset, 'i')).toBe('independent.asset');
    expect(tagValue(asset, 'version')).toBe('2');
    expect(tagValue(asset, 'filename')).toBe('file');
    expect(tagValue(release, 'a')).toBe(`32267:${testPubkey()}:app`);
    expect(tagValues(release, 'f')).toEqual(['linux-x86_64']);
    await publishJournal(h.b, testRepo(), journal);
    expect(h.published).toEqual(journal.events.map((e) => e.id));
    expect(await loadJournal(h.b, testRepo())).toBeNull();
  });
  it('requires APK fields and safe URLs before asking for signatures', async () => {
    const h = host(),
      d = draft();
    d.artifacts[0]!.mimeType = 'application/vnd.android.package-archive';
    await expect(preparePublication(h.b, testRepo(), d)).rejects.toThrow('APK requires');
    expect(h.calls).toEqual([]);
    d.artifacts[0]!.versionCode = 1;
    d.artifacts[0]!.apkCertificateHashes = ['b'.repeat(64)];
    expect(
      buildAssetEvent({ appId: 'app', version: '1', artifact: d.artifacts[0]! })
    ).toBeDefined();
    d.artifacts[0]!.url = 'javascript:alert(1)';
    await expect(preparePublication(h.b, testRepo(), d)).rejects.toThrow('HTTPS');
  });
  it('rejects changed signer/context without publishing', async () => {
    const h = host();
    h.setSigner(2);
    await expect(preparePublication(h.b, testRepo(), draft())).rejects.toThrow(
      'different event or publisher'
    );
    h.setViewer(testPubkey(2));
    await expect(preparePublication(h.b, testRepo(), draft())).rejects.toThrow('account changed');
    expect(h.published).toEqual([]);
  });
  it('resumes a lost publish response with the same persisted event IDs, no signatures', async () => {
    const h = host();
    const journal = await preparePublication(h.b, testRepo(), draft());
    h.fail(true);
    await expect(publishJournal(h.b, testRepo(), journal)).rejects.toThrow('timed out');
    const signatures = h.calls.filter((c) => c === 'nostr:sign').length;
    const saved = await loadJournal(h.b, testRepo());
    h.fail(false);
    await publishJournal(h.b, testRepo(), saved!);
    expect(h.published[0]).toBe(h.published[1]);
    expect(h.calls.filter((c) => c === 'nostr:sign')).toHaveLength(signatures);
  });
});
