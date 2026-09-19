# @charlescstpierr/vizion

Serveur local pour [Vizion](https://github.com/charlescstpierr/vision) : jumelle
l'extension de navigateur Vizion à un agent de code (Claude ou Codex) pour que tu
puisses modifier les pages en direct de ton projet depuis le navigateur.

## Utilisation

Depuis le dossier de ton projet :

```sh
npx @charlescstpierr/vizion
```

Options facultatives :

- `--port <number>` — port d'écoute (par défaut `7331`)
- `--help`, `-h` — affiche l'usage
- `--version` — affiche la version installée

Le serveur se lie uniquement à `127.0.0.1`, affiche le port sur lequel il écoute
ainsi que les CLI d'agent (`codex`, `claude`) détectés sur le `PATH`, et accepte
les connexions WebSocket de l'extension de navigateur Vizion.

## En savoir plus

Consulte le [dépôt principal](https://github.com/charlescstpierr/vision) pour
l'extension, le mode Overlay, et la documentation complète.
