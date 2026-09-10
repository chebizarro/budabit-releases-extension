import { describe, expect, it, vi } from 'vitest';
import type { WidgetBridge } from 'budabit-sdk';
import { loadReleaseDetail, parseAsset, platformLabel } from './releases.js';
import { releaseNotesHtml } from './markdown.js';
import { releaseFixture, signed, testRepo } from './test-fixtures.js';

describe('release detail', () => {
  it('preserves independent asset identity, explicit filename, relay hints and unresolved IDs', async () => {
    const asset = signed({ kind: 3063, tags: [['i', 'independent'], ['version', '2'], ['x', 'b'.repeat(64)], ['m', 'application/octet-stream'], ['filename', 'declared.bin']] }, 2);
    const release = releaseFixture({ tags: [...releaseFixture().tags, ['e', asset.id, 'wss://hint.example/'], ['e', 'c'.repeat(64), 'javascript:bad']] });
    const request = vi.fn(async () => ({ status: 'ok', complete: false, events: [asset] }));
    const detail = await loadReleaseDetail({ request } as unknown as WidgetBridge, testRepo(), release);
    expect(detail.assets[0]).toMatchObject({ appId: 'independent', version: '2', filename: 'declared.bin' });
    expect(detail.unresolvedAssetIds).toEqual(['a'.repeat(64), 'c'.repeat(64)]);
    expect(detail.complete).toBe(false);
    expect(request).toHaveBeenCalledWith('nostr:query', expect.objectContaining({ relays: ['wss://hint.example'] }));
    expect(platformLabel([])).toBe('Not declared');
    expect(parseAsset(signed({ ...asset, tags: [...asset.tags, ['url', 'javascript:bad']] }))).toBeNull();
  });
  it('sanitizes notes without accumulating global hooks or making tracking requests', () => {
    const notes = '# Notes\n[download](https://files.example/app)\n<img src="https://tracker.example" onerror="alert(1)"><script>alert(1)</script><a href="javascript:bad">bad</a>';
    const first = releaseNotesHtml(notes), second = releaseNotesHtml(notes);
    expect(first).toBe(second);
    const root = document.createElement('div'); root.innerHTML = first;
    expect(root.querySelector('h1')?.textContent).toBe('Notes');
    expect(root.querySelector('a')?.getAttribute('target')).toBe('_blank');
    expect(root.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(root.querySelector('img, script, [onerror], [href^="javascript:"]')).toBeNull();
  });
});
