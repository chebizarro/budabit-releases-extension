import { describe, expect, it } from 'vitest';
import type { NostrEvent, WidgetBridge } from 'budabit-sdk';
import { loadPipelineArtifacts } from './pipelines.js';
import { signed, testPubkey, testRepo } from './test-fixtures.js';

const run = (key = 1, commit = 'a'.repeat(40)) =>
  signed(
    {
      kind: 5401,
      tags: [
        ['a', testRepo().repoAddress],
        ['triggered-by', testPubkey()],
        ['publisher', testPubkey(3)],
        ['commit', commit],
      ],
    },
    key
  );
const artifact = (refs: string[] = []) =>
  signed(
    {
      kind: 1063,
      tags: [
        ['url', 'https://files.example/app'],
        ['x', 'b'.repeat(64)],
        ['filename', 'app'],
        ['m', 'application/octet-stream'],
        ...refs.map((id) => ['e', id]),
      ],
    },
    3
  );
const bridge = (runs: NostrEvent[], assets: NostrEvent[]) =>
  ({
    request: async (_: string, p: { filter: { kinds: number[] } }) => ({
      status: 'ok',
      complete: true,
      events: p.filter.kinds[0] === 5401 ? runs : assets,
    }),
  }) as unknown as WidgetBridge;

describe('authenticated pipeline artifacts', () => {
  it('rejects spoofed triggered-by, even with valid attacker signatures', async () => {
    expect(
      (await loadPipelineArtifacts(bridge([run(2)], [artifact()]), testRepo())).runs
    ).toHaveLength(0);
  });
  it('isolates a run and deduplicates events without worker votes', async () => {
    const r = run(),
      a = artifact([r.id]);
    const data = await loadPipelineArtifacts(bridge([r, r], [a, a]), testRepo());
    expect(data.artifactsByRun.get(r.id)).toHaveLength(1);
    expect(data.artifactsByRun.get(r.id)?.[0]?.commitId).toBe('a'.repeat(40));
  });
  it('rejects reused ambiguous publisher delegations', async () => {
    const data = await loadPipelineArtifacts(
      bridge([run(), run(1, 'c'.repeat(40))], [artifact()]),
      testRepo()
    );
    expect(data.runs).toHaveLength(0);
  });
  it('rejects contradictory references and wrong artifact authors', async () => {
    const r = run();
    const data = await loadPipelineArtifacts(
      bridge(
        [r],
        [artifact(['d'.repeat(64)]), signed({ ...artifact(), tags: artifact().tags }, 2)]
      ),
      testRepo()
    );
    expect(data.artifactsByRun.size).toBe(0);
  });
});
