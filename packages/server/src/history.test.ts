import { describe, expect, it } from 'vitest';
import type { RunRecord } from '@vizion/shared';
import { RunHistory } from './history.js';
import type { UndoFile } from './snapshot.js';

function makeRecord(overrides: Partial<Omit<RunRecord, 'id'>> = {}): Omit<RunRecord, 'id'> {
  return {
    agent: 'claude',
    prompt: 'do it',
    selectors: ['#a'],
    createdAt: Date.now(),
    files: ['a.txt'],
    status: 'accepted',
    ...overrides,
  };
}

describe('RunHistory', () => {
  it('adds records with a generated id and lists newest first', () => {
    const history = new RunHistory();
    const first = history.add(makeRecord({ prompt: 'first' }), []);
    const second = history.add(makeRecord({ prompt: 'second' }), []);

    expect(first.id).toEqual(expect.any(String));
    expect(first.id).not.toBe(second.id);
    expect(history.list().map((r) => r.prompt)).toEqual(['second', 'first']);
  });

  it('caps history at 50 entries, dropping the oldest', () => {
    const history = new RunHistory();
    for (let i = 0; i < 55; i++) {
      history.add(makeRecord({ prompt: `run-${i}` }), []);
    }
    const list = history.list();
    expect(list).toHaveLength(50);
    expect(list[0]?.prompt).toBe('run-54');
    expect(list[49]?.prompt).toBe('run-5');
  });

  it('get returns the stored record and its files; unknown ids are undefined', () => {
    const history = new RunHistory();
    const files: UndoFile[] = [
      {
        path: 'a.txt',
        before: { content: Buffer.from('old'), mode: 0o644 },
        after: { content: Buffer.from('new'), mode: 0o644 },
      },
    ];
    const record = history.add(makeRecord(), files);

    const entry = history.get(record.id);
    expect(entry?.record).toEqual(record);
    expect(entry?.files).toEqual(files);
    expect(history.get('missing')).toBeUndefined();
  });

  it('markUndone flips status to undone and reports whether the id was found', () => {
    const history = new RunHistory();
    const record = history.add(makeRecord(), []);

    expect(history.markUndone('missing')).toBe(false);
    expect(history.markUndone(record.id)).toBe(true);
    expect(history.list()[0]?.status).toBe('undone');
  });
});
