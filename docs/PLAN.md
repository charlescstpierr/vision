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
- Stack extension: TypeScript, Vite, React, framework WXT (cibles Edge et Chrome).
- Racine du projet: le serveur est lancé dans le dossier du projet (`npx vizion`), son cwd est la racine de recherche donnée à l'agent.
- Validation: sortie de l'agent en streaming dans le panneau, puis diff des fichiers avec Accepter / Rejeter avant application.
- MVP: sélection + prompt texte, édition inline du texte, panneau de styles rapides (couleur, taille, marge) sans passer par l'agent.
- OS: Windows et macOS.
- Nom npm: `@charlescstpierr/vizion`, commande `vizion` (le nom `vizion` est déjà pris).
- Sub-agents: Sonnet pour tout ce qui touche la config, les APIs d'extension, le serveur et le diff. Haiku seulement pour des composants isolés avec spec précise et pour la documentation.

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
- **Side panel (React)**: tient la connexion WebSocket au serveur (un service worker MV3 est tué après 30 s d'inactivité, le side panel est un document persistant). Affiche l'état de connexion au serveur, élément sélectionné, choix de l'agent, champ prompt, sortie streaming, vue diff avec Accepter / Rejeter, panneau de styles rapides, liste des overrides overlay pour l'URL courante.
- **Service worker**: relais des messages content script ↔ side panel, ouverture du side panel au clic sur l'icône, stockage des overrides (`chrome.storage.local`).

### 3.2 Serveur local (`packages/server`)

- Démarré par `npx vizion` dans le dossier du projet. Écoute sur `127.0.0.1:7331` (configurable).
- Endpoints: `GET /health` (version, cwd, agents disponibles), WebSocket `/ws` pour les sessions d'édition.
- **AgentRunner** (interface): `run(request) → AsyncIterable<AgentEvent>`. Deux implémentations:
  - `CodexRunner`: lance `codex` en mode non interactif (`codex exec`), lit stdout en streaming.
  - `ClaudeRunner`: lance `claude -p --output-format stream-json`, lit les événements.
- **Diff et rejet**: avant de lancer l'agent, le serveur prend un instantané (`git status --porcelain` + contenu des fichiers déjà modifiés ou non suivis). Après, il compare et envoie au panneau un diff limité aux fichiers touchés par l'agent. Accepter = ne rien faire. Rejeter = restaurer chaque fichier touché à partir de l'instantané (`git checkout HEAD` si le fichier était propre, contenu sauvegardé sinon, suppression si nouveau).
- **Permissions des agents**: les CLIs sont lancés en mode édition automatique (`codex exec --full-auto`, `claude -p --permission-mode acceptEdits`), parce que le diff Accepter / Rejeter est le portail de validation. Sans ça, l'exécution bloque sur une confirmation interactive.
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

État au 2026-09-18: les jalons 1 à 7 sont livrés sur la branche de travail. L'édition inline se déclenche par le bouton « Edit text » du panneau (pas par double-clic). Le runner Codex est écrit d'après la documentation du CLI, pas vérifié contre un binaire.

| # | Jalon | Livrable | Sub-agents |
|---|---|---|---|
| 1 | Squelette monorepo | pnpm workspace, TS strict, WXT + React, extension « hello » chargeable dans Edge et Chrome, serveur `/health`, vitest | Sonnet |
| 2 | Sélection d'élément | Overlay hover/clic, `ElementContext` extrait, affiché dans le side panel | Sonnet |
| 3 | Serveur + runners | WebSocket dans le side panel, `AgentRunner`, `CodexRunner`, `ClaudeRunner`, streaming vers le panneau | Sonnet (serveur), Haiku (vue streaming) |
| 4 | Diff + Accepter / Rejeter | Instantané, diff des fichiers touchés, vue diff, restauration sur rejet | Sonnet |
| 5 | Mode overlay | Overrides DOM/CSS persistés par URL, ré-application au chargement (MutationObserver), liste dans le panneau | Sonnet |
| 6 | Édition inline + styles rapides | Double-clic texte, panneau couleur / taille / marge, génère un override (overlay) ou un prompt agent (source) | Haiku, spec fournie |
| 7 | Finition | README d'installation Windows/macOS, paquet publiable, tests de bout en bout sur Edge et Chrome | Sonnet (tests), Haiku (README) |

Dépendances: 2 dépend de 1. Les jalons 3 → 4 et 5 → 6 sont deux chaînes indépendantes qui partent de 2 et peuvent avancer en parallèle. 7 dépend de tout.

Chaque jalon = un commit revu sur la branche de travail avant le suivant.

## 6. Risques et points ouverts

- **Précision du « l'agent trouve lui-même le fichier »**: sur un gros projet, l'agent peut se tromper de fichier. Atténuation: on inclut le chemin DOM complet et les classes, et on ajoute plus tard les source maps React (`data-source` / `__reactFiber` `_debugSource`) si disponibles.
- **Format de sortie des CLIs**: `codex exec` et `claude -p --output-format stream-json` évoluent. Le runner isole ça derrière l'interface.
- **Sécurité du serveur local**: écoute seulement sur `127.0.0.1`, et vérifie l'origine `chrome-extension://<id>` des connexions WebSocket.
- **Mode overlay sur sites tiers**: certains sites ont un CSP strict ou re-rendent le DOM (React) et écrasent les overrides. Atténuation: MutationObserver qui ré-applique.
