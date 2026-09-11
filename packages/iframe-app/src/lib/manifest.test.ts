// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('offline manifest generation', () => {
  it('expands the configured URL and declares exactly the release capabilities', () => {
    const destination = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'release-manifest-test-'));
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    try {
      execFileSync(
        'bash',
        ['-c', `${packageJson.scripts['manifest:generate']} --output "$MANIFEST_TEST_OUTPUT"`],
        {
          env: {
            ...process.env,
            WIDGET_APP_URL: 'https://cdn.example/releases.html',
            MANIFEST_TEST_OUTPUT: destination,
            PATH: `${resolve('node_modules/.bin')}:${process.env.PATH}`,
          },
          stdio: 'pipe',
        }
      );
      const event = JSON.parse(readFileSync(join(destination, 'event.json'), 'utf8')) as {
        kind: number;
        tags: string[][];
      };
      expect(event.kind).toBe(30033);
      expect(event.tags.find((t) => t[0] === 'button')).toContain(
        'https://cdn.example/releases.html'
      );
      expect(event.tags.filter((t) => t[0] === 'permission').map((t) => t[1])).toEqual([
        'nostr:sign',
        'nostr:publish',
        'nostr:query',
        'nostr:subscribe',
        'nostr:unsubscribe',
        'storage:get',
        'storage:set',
        'storage:compareAndSet',
      ]);
      expect(event.tags.filter((t) => t[0] === 'nostrKinds').map((t) => t[1])).toEqual([
        '32267',
        '30063',
        '3063',
        '1063',
        '5401',
      ]);
      expect(JSON.stringify(event)).not.toContain('${');
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});
