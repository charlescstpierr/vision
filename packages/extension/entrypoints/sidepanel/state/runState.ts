import type { AgentEvent, AgentKind, FileDiff, ServerMessage } from '@vizion/shared';

export interface RunState {
  running: boolean;
  agent: AgentKind | null;
  events: AgentEvent[];
  diff: FileDiff[] | null;
  error: string | null;
  exitCode: number | null;
}

export type RunAction =
  | { type: 'server'; message: ServerMessage }
  | { type: 'start'; agent: AgentKind; prompt: string }
  | { type: 'clear' };

export const initialRunState: RunState = {
  running: false,
  agent: null,
  events: [],
  diff: null,
  error: null,
  exitCode: null,
};

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'start':
      return {
        running: true,
        agent: action.agent,
        events: [],
        diff: null,
        error: null,
        exitCode: null,
      };
    case 'clear':
      return initialRunState;
    case 'server': {
      const message = action.message;
      switch (message.type) {
        case 'event': {
          const event = message.event;
          const events = [...state.events, event];
          if (event.type === 'done') {
            return { ...state, events, running: false, exitCode: event.exitCode };
          }
          if (event.type === 'error') {
            return { ...state, events, running: false, error: event.message };
          }
          return { ...state, events };
        }
        case 'diff':
          return { ...state, diff: message.files };
        case 'error':
          return { ...state, running: false, error: message.message };
        case 'hello':
        case 'pong':
          return state;
        default:
          // Unknown ServerMessage variant (e.g. added concurrently by another
          // agent working on the server/shared packages): no-op.
          return state;
      }
    }
    default:
      return state;
  }
}
