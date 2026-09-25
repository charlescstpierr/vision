import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRunner, ClientMessage, ServerMessage } from '@vizion/shared';
import { DecisionError, type Decisions } from './decisions.js';
import { parseOverlayProposal } from './overlay.js';
import { decodeScreenshot, writeScreenshotFile } from './screenshot.js';
import { takeSnapshot } from './snapshot.js';

type Run = Extract<ClientMessage, { type: 'run' }>;
export type RunContext = {
  readonly cwd: string;
  readonly runners: readonly AgentRunner[];
  readonly decisions: Decisions;
};
export type RunChannel = {
  readonly signal: AbortSignal;
  readonly send: (message: ServerMessage) => void;
};

/** Executes a reserved run; its baseline outlives the initiating connection. */
export async function executeRun(context: RunContext, message: Run, channel: RunChannel): Promise<void> {
  const { cwd, runners, decisions } = context;
  const { signal, send } = channel;
  let overlayTempDir: string | null = null;
  let screenshotDir: string | null = null;
  try {
    const runner = runners.find((candidate) => candidate.kind === message.agent);
    if (!runner || !(await runner.isAvailable())) {
      send({ type: 'error', message: `agent non disponible : ${message.agent}` });
      return;
    }
    let screenshotPath: string | undefined;
    if (message.screenshot) {
      const decoded = decodeScreenshot(message.screenshot.dataUrl);
      if ('error' in decoded) {
        send({ type: 'error', message: decoded.error });
        return;
      }
      screenshotPath = await writeScreenshotFile(decoded.buffer, decoded.ext);
      screenshotDir = path.dirname(screenshotPath);
    }
    if (message.mode === 'overlay') {
      overlayTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-overlay-'));
      const request = {
        agent: message.agent, prompt: message.prompt, element: message.element,
        elements: message.elements, pageUrl: message.element.pageUrl,
        cwd: overlayTempDir, mode: message.mode, readOnly: true, screenshotPath,
      };
      let accumulatedText = '';
      for await (const event of runner.run(request, signal)) {
        send({ type: 'event', event });
        if (event.type === 'text') accumulatedText += event.text;
      }
      const selectors = (message.elements ?? [message.element]).map((element) => element.selector);
      const result = parseOverlayProposal(accumulatedText, selectors);
      await fs.rm(overlayTempDir, { recursive: true, force: true });
      overlayTempDir = null;
      if (screenshotDir) {
        await fs.rm(screenshotDir, { recursive: true, force: true });
        screenshotDir = null;
      }
      if ('error' in result) send({ type: 'error', message: result.error });
      else send({ type: 'overlay-proposal', overrides: result.overrides, ...(result.note ? { note: result.note } : {}) });
      return;
    }

    const snapshot = await takeSnapshot(cwd);
    const oversized = [...snapshot.files.values()].filter((file) => file.tooLarge).map((file) => file.path);
    if (oversized.length > 0) {
      throw new DecisionError({
        type: 'error', code: 'snapshot-too-large', paths: oversized,
        message: `Run refusé : fichiers modifiés trop volumineux (> 5 MiB) : ${oversized.join(', ')}`,
      });
    }
    const request = {
      agent: message.agent, prompt: message.prompt, element: message.element,
      elements: message.elements, pageUrl: message.element.pageUrl, cwd, screenshotPath,
    };
    try {
      for await (const event of runner.run(request, signal)) send({ type: 'event', event });
    } finally {
      // Recovery must run even if screenshot cleanup fails.
      try {
        if (screenshotDir) {
          await fs.rm(screenshotDir, { recursive: true, force: true });
          screenshotDir = null;
        }
      } finally {
        await decisions.capture(snapshot, message);
      }
    }
  } finally {
    if (overlayTempDir) await fs.rm(overlayTempDir, { recursive: true, force: true });
    if (screenshotDir) await fs.rm(screenshotDir, { recursive: true, force: true });
  }
}
