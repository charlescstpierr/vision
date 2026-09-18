import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';

describe('server', () => {
  it('serves /health with the expected shape', async () => {
    const cwd = process.cwd();
    const server = createServer({ port: 0, cwd });
    await server.start();
    try {
      const port = server.port;
      expect(port).toBeTypeOf('number');
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        name: string;
        version: string;
        cwd: string;
        agents: unknown[];
      };
      expect(body.name).toBe('vizion');
      expect(typeof body.version).toBe('string');
      expect(body.cwd).toBe(cwd);
      expect(Array.isArray(body.agents)).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
