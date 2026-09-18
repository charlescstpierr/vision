import { describe, expect, it } from 'vitest';
import { parseClaudeLine } from './claude.js';

describe('parseClaudeLine', () => {
  it('turns a system/init line into a started event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/home/user/project',
      session_id: 'abc',
    });
    expect(parseClaudeLine(line)).toEqual([{ type: 'started', agent: 'claude' }]);
  });

  it('turns an assistant text block into a text event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] },
    });
    expect(parseClaudeLine(line)).toEqual([{ type: 'text', text: 'Working on it' }]);
  });

  it('turns an assistant tool_use block into a tool event with file_path detail', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/Button.tsx' } }],
      },
    });
    expect(parseClaudeLine(line)).toEqual([
      { type: 'tool', name: 'Edit', detail: '/src/Button.tsx' },
    ]);
  });

  it('turns an assistant tool_use block into a tool event with command detail', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hello-vizion-test' } }],
      },
    });
    expect(parseClaudeLine(line)).toEqual([
      { type: 'tool', name: 'Bash', detail: 'echo hello-vizion-test' },
    ]);
  });

  it('handles multiple content blocks in one assistant line', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      },
    });
    expect(parseClaudeLine(line)).toEqual([
      { type: 'text', text: 'first' },
      { type: 'tool', name: 'Read', detail: undefined },
    ]);
  });

  it('turns a successful result line into a done event with exitCode 0', () => {
    const line = JSON.stringify({
      is_error: false,
      subtype: 'success',
      result: 'Output: `hello-vizion-test`',
      type: 'result',
    });
    expect(parseClaudeLine(line)).toEqual([{ type: 'done', exitCode: 0 }]);
  });

  it('turns an errored result line into a done event with exitCode 1', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, subtype: 'error' });
    expect(parseClaudeLine(line)).toEqual([{ type: 'done', exitCode: 1 }]);
  });

  it('ignores lines it does not recognize', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'active_goal', value: null }))).toEqual([]);
    expect(parseClaudeLine(JSON.stringify({ type: 'autocompact_state', value: {} }))).toEqual([]);
  });

  it('ignores unparseable lines instead of throwing', () => {
    expect(parseClaudeLine('not json at all')).toEqual([]);
    expect(parseClaudeLine('')).toEqual([]);
  });
});
