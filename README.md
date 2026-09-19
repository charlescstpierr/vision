# Vizion

Edit live websites from Microsoft Edge or Chrome with a coding agent: run the local server, select an element, describe the change, and accept or reject the diff.

## How it works

1. Run the local Vizion server in your project folder (skip this for overlay mode).
2. Open the page in Edge or Chrome (from your dev server or any site).
3. Click the toolbar icon to open the Vizion side panel.
4. Click "Select element", then click the element you want to change.
5. Describe the change in the prompt, pick an agent, and send. Stream the output, review the diff, accept or reject.

**Two modes:**

- **Source mode**: Server running, page from your dev server (localhost). The agent edits your project files, finding the right source file by context.
- **Overlay mode**: No server, or any site you do not have the source of. Your quick edits (text, styles) are saved as overrides in the extension, per page URL, and re-applied on every page load. No agent is involved.

## Requirements

- Node.js 22+
- pnpm 10+
- Microsoft Edge or Chrome
- At least one agent CLI on PATH: `codex` or `claude`

Agents run in auto-edit mode (the diff Accept/Reject dialog is the safety gate); manage changes with git.

## Install

Clone the repo and install dependencies:

```sh
git clone https://github.com/charlescstpierr/vision.git
cd vision
pnpm install
pnpm -r build
```

**Load the extension:**

- **Edge**: Open `edge://extensions`, enable Developer mode, click "Load unpacked", select `packages/extension/.output/chrome-mv3`.
- **Chrome**: Open `chrome://extensions`, enable Developer mode, click "Load unpacked", select `packages/extension/.output/chrome-mv3`.

For an Edge-specific build, run `pnpm --filter @vizion/extension build:edge` (outputs to `.output/edge-mv3`).

## Run the local server

From your project folder:

```sh
node /path/to/vizion/packages/server/dist/cli.js
```

Add optional `--port` to change the port (default 7331).

Once published to npm, use:

```sh
npx @charlescstpierr/vizion
```

The server prints detected agents and binds to `127.0.0.1` only, accepting WebSocket connections from the extension.

## Help the agent find the file (optional)

In a Vite + React project, add the plugin to `vite.config.ts` (dev only, guarded by `command`):

```ts
export default defineConfig(({ command }) => ({
  plugins: [react({ babel: { plugins: command === 'serve' ? ['@vizion/babel-plugin-source'] : [] } })],
}));
```

Install it as a dev dependency:

```sh
npm i -D @vizion/babel-plugin-source
```

It annotates every JSX host element (`div`, `button`, ...) with a `data-vizion-source="file:line:column"` attribute. Vizion reads it from the selected element (or its nearest annotated ancestor) and passes it to the agent, so it starts at the right file instead of guessing from the DOM.

## Use it

1. Open the side panel (click the toolbar icon).
2. Status line shows "Source mode" (server + localhost) or "Overlay mode" (no server).
3. Click "Select element" and click the element to modify.
4. The element card shows the selector, DOM path, and computed styles.
5. Quick edits: "Edit text" button, color/size/margin rows, or write a full prompt.
6. Pick an agent (Codex or Claude), then "Send to agent".
7. Watch the streaming output in the panel.
8. When done, review the diff, click "Accept" or "Reject".

## Windows and macOS notes

- **Windows**: The server looks for `codex.cmd` and `claude.cmd` on PATH.
- **macOS**: Ensure the agent CLIs are on the PATH of the shell you start the server from. If you installed via Homebrew or manually, add the bin directory to your shell profile (e.g., `.zshrc` or `.bash_profile`).

## Development

```sh
pnpm -r test         # Run all tests
pnpm -r typecheck    # TypeScript checks
pnpm -r lint         # ESLint
pnpm --filter @vizion/extension dev  # WXT dev mode (auto-rebuild on change)
```

Architecture and implementation plan: [docs/PLAN.md](docs/PLAN.md)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Server not running" in the side panel | Start the server (see "Run the local server"), check that port 7331 is free, or pass `--port`. |
| "Reload the page to enable Vizion on it." | Content script did not load. Reload the page, or reinstall the extension. |
| No agents detected | Install `codex` or `claude` CLI, verify it's on PATH, restart the server. |
| Reject does nothing, empty diff | The diff and reject features need your project to be a git repository. |
| Overlay mode not persisting | Some sites have strict Content Security Policy or re-render the DOM; overrides may not survive. |
