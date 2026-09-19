# @charlescstpierr/vizion

Local server for [Vizion](https://github.com/charlescstpierr/vision): pairs the
Vizion browser extension with a coding agent (Claude or Codex) so you can edit
your project's live pages from the browser.

## Usage

From your project folder:

```sh
npx @charlescstpierr/vizion
```

Optional flags:

- `--port <number>` — port to listen on (default `7331`)
- `--help`, `-h` — print usage
- `--version` — print the installed version

The server binds to `127.0.0.1` only, prints the port it is listening on and
which agent CLIs (`codex`, `claude`) it detected on `PATH`, and accepts
WebSocket connections from the Vizion browser extension.

## More

See the [main repository](https://github.com/charlescstpierr/vision) for the
extension, overlay mode, and full documentation.
