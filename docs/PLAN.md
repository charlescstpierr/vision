# Vizion — Plan de réalisation

## 1. Résumé

Extension Chromium (Edge + Chrome, Manifest V3) qui permet de sélectionner un élément d'une page, de décrire une modification, et de la faire appliquer par un agent de code local (Codex CLI ou Claude Code) via un serveur Node sur la machine de l'utilisateur.

Deux modes:

| Mode | Quand | Ce que l'agent modifie |
|---|---|---|
| **Source** | Le serveur local tourne et la page vient d'un dev server (localhost) | Les fichiers du projet, l'agent cherche lui-même le bon fichier à partir du contexte de l'élément |
| **Overlay** | Pas de serveur, ou site distant | Le DOM / CSS dans le navigateur, overrides persistés par URL dans le storage de l'extension |

## 2. Décisions prises

- Cas d'usage: les deux modes (source + overlay).
- Agent: Codex CLI et Claude Code, sélectionnable, derrière une abstraction `AgentRunner`.
- Liaison extension ↔ machine: serveur Node local (HTTP + WebSocket sur `127.0.0.1`).
- Stack extension: TypeScript, Vite, React, plugin CRXJS.
- Racine du projet: le serveur est lancé dans le dossier du projet (`npx vizion`), son cwd est la racine de recherche donnée à l'agent.
- Validation: sortie de l'agent en streaming dans le panneau, puis diff des fichiers avec Accepter / Rejeter avant application.
- MVP: sélection + prompt texte, édition inline du texte, panneau de styles rapides (couleur, taille, marge) sans passer par l'agent.
- OS: Windows et macOS.

## 3. Architecture

Monorepo pnpm avec trois paquets.

```
vizion/
  packages/
    shared/      types partagés (messages, ElementContext, Diff, AgentEvent)
    extension/   extension MV3 (content script, side panel React, service worker)
    server/      serveur Node local + runners d'agents (npx vizion)
  docs/
```

### 3.1 Extension

- **Content script**: overlay de sélection (hover highlight, clic = sélection), extraction du contexte de l'élément (sélecteur CSS unique, outerHTML tronqué, classes, styles calculés pertinents, texte, chemin DOM, position). Édition inline du texte (double-clic → contenteditable). Application des overrides overlay au chargement de la page.
- **Side panel (React)**: état de connexion au serveur, élément sélectionné, choix de l'agent, champ prompt, sortie streaming, vue diff avec Accepter / Rejeter, panneau de styles rapides, liste des overrides overlay pour l'URL courante.
- **Service worker**: relais des messages content script ↔ side panel, client WebSocket vers le serveur, détection de la présence du serveur (ping), stockage des overrides (`chrome.storage.local`).

### 3.2 Serveur local (`packages/server`)

- Démarré par `npx vizion` dans le dossier du projet. Écoute sur `127.0.0.1:7331` (configurable).
- Endpoints: `GET /health` (version, cwd, agents disponibles), WebSocket `/ws` pour les sessions d'édition.
- **AgentRunner** (interface): `run(request) → AsyncIterable<AgentEvent>`. Deux implémentations:
  - `CodexRunner`: lance `codex` en mode non interactif (`codex exec`), lit stdout en streaming.
  - `ClaudeRunner`: lance `claude -p --output-format stream-json`, lit les événements.
- **Sandbox de diff**: l'agent travaille dans une copie git (`git worktree` temporaire) ou, plus simple pour le MVP, directement dans le projet avec `git stash` de sécurité, puis `git diff` est envoyé au panneau. Accepter = garder, Rejeter = `git checkout` des fichiers touchés. Décision au jalon 3.
- Détection des CLIs (`which codex` / `which claude`, chemins Windows inclus).

### 3.3 Prompt envoyé à l'agent

Construit côté serveur à partir de `ElementContext` + prompt utilisateur:

```
Projet: <cwd>. Page: <url>.
Élément sélectionné: <sélecteur>, chemin DOM: <…>, classes: <…>, texte: "<…>".
HTML: <outerHTML tronqué>.
Tâche: <prompt utilisateur>.
Trouve le fichier source qui rend cet élément et applique la modification. Ne touche à rien d'autre.
```

## 4. Flux principal (mode source)

1. Utilisateur lance `npx vizion` dans son projet, ouvre `localhost:3000` dans Edge, ouvre le side panel.
2. Service worker détecte le serveur (`/health`), le panneau passe en mode Source.
3. Utilisateur active la sélection, clique un élément. Le content script envoie `ElementContext` au panneau.
4. Utilisateur écrit « mets ce bouton en bleu », choisit Codex ou Claude, envoie.
5. Serveur lance le runner, streame les événements au panneau.
6. À la fin, serveur envoie le `git diff`. Panneau affiche le diff, Accepter / Rejeter.
7. Accepter: rien à faire, le hot reload du dev server a déjà rafraîchi la page. Rejeter: serveur restaure les fichiers.

## 5. Jalons

| # | Jalon | Livrable | Sub-agents |
|---|---|---|---|
| 0 | Squelette monorepo | pnpm workspace, TS, ESLint, Vite + CRXJS, extension « hello » chargée dans Edge, serveur `/health` | 1 agent (haiku, effort bas) |
| 1 | Sélection d'élément | Overlay hover/clic, `ElementContext` extrait, affiché dans le side panel | 1 agent (sonnet, effort moyen) |
| 2 | Serveur + runners | WebSocket, `AgentRunner`, `CodexRunner`, `ClaudeRunner`, streaming vers le panneau | 2 agents en parallèle: serveur (sonnet), UI streaming (haiku) |
| 3 | Diff + Accepter / Rejeter | Génération du diff, vue diff dans le panneau, restauration sur rejet | 1 agent (sonnet) |
| 4 | Mode overlay | Overrides DOM/CSS persistés par URL, ré-application au chargement, liste dans le panneau | 1 agent (sonnet) |
| 5 | Édition inline + styles rapides | Double-clic texte, panneau couleur / taille / marge, génère un override (overlay) ou un prompt agent (source) | 2 agents en parallèle (haiku) |
| 6 | Finition | README d'installation Windows/macOS, `npx vizion` publiable, tests de bout en bout sur Edge et Chrome | 1 agent (haiku) |

Chaque jalon = une PR sur la branche de travail, revue avant le suivant.

## 6. Risques et points ouverts

- **Précision du « l'agent trouve lui-même le fichier »**: sur un gros projet, l'agent peut se tromper de fichier. Atténuation: on inclut le chemin DOM complet et les classes, et on ajoute plus tard les source maps React (`data-source` / `__reactFiber` `_debugSource`) si disponibles.
- **Format de sortie des CLIs**: `codex exec` et `claude -p --output-format stream-json` évoluent. Le runner isole ça derrière l'interface.
- **Sécurité du serveur local**: écoute seulement sur `127.0.0.1`, et vérifie l'origine `chrome-extension://<id>` des connexions WebSocket.
- **Mode overlay sur sites tiers**: certains sites ont un CSP strict ou re-rendent le DOM (React) et écrasent les overrides. Atténuation: MutationObserver qui ré-applique.
