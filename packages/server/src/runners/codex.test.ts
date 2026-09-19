import { describe, expect, it } from 'vitest';
import { parseCodexLine } from './codex.js';

describe('parseCodexLine', () => {
  it('turns an agent_message item into a text event', () => {
    const line = JSON.stringify({ type: 'item', item: { type: 'agent_message', text: 'Working on it' } });
    expect(parseCodexLine(line)).toEqual([{ type: 'text', text: 'Working on it' }]);
  });

  it('turns a command_execution item into a tool event with the command as detail', () => {
    const line = JSON.stringify({
      type: 'item',
      item: { type: 'command_execution', command: 'npm test' },
    });
    expect(parseCodexLine(line)).toEqual([
      { type: 'tool', name: 'command_execution', detail: 'npm test' },
    ]);
  });

  it('turns a file_change item into a tool event with the path as detail', () => {
    const line = JSON.stringify({
      type: 'item',
      item: { type: 'file_change', path: 'src/Button.tsx' },
    });
    expect(parseCodexLine(line)).toEqual([
      { type: 'tool', name: 'file_change', detail: 'src/Button.tsx' },
    ]);
  });

  it('treats an unrecognized item type that carries a command as tool-like', () => {
    const line = JSON.stringify({ item: { type: 'shell_call', command: 'ls' } });
    expect(parseCodexLine(line)).toEqual([{ type: 'tool', name: 'shell_call', detail: 'ls' }]);
  });

  it('turns a turn-completed envelope into a done event', () => {
    const line = JSON.stringify({ type: 'turn_completed', exit_code: 0 });
    expect(parseCodexLine(line)).toEqual([{ type: 'done', exitCode: 0 }]);
  });

  it('turns an error envelope into an error event', () => {
    const line = JSON.stringify({ type: 'error', message: 'model overloaded' });
    expect(parseCodexLine(line)).toEqual([{ type: 'error', message: 'model overloaded' }]);
  });

  it('falls back to a text event with the raw line for non-JSON output', () => {
    expect(parseCodexLine('codex: starting session')).toEqual([
      { type: 'text', text: 'codex: starting session' },
    ]);
  });

  it('ignores empty lines', () => {
    expect(parseCodexLine('')).toEqual([]);
    expect(parseCodexLine('   ')).toEqual([]);
  });

  it('ignores JSON with no recognizable shape', () => {
    expect(parseCodexLine(JSON.stringify({ hello: 'world' }))).toEqual([]);
  });
});
