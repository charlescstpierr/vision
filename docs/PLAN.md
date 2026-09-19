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
- Validation: sortie de l'agent en streaming dans le panneau, puis diff des fichiers touchés. Le diff est informatif, pas une porte: l'agent écrit en mode auto-edit, donc les fichiers sont déjà sur disque quand il s'affiche. Le retour en arrière est l'annulation depuis l'historique.
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
- **Side panel (React)**: tient la connexion WebSocket au serveur (un service worker MV3 est tué après 30 s d'inactivité, le side panel est un document persistant). Affiche l'état de connexion au serveur, élément sélectionné, choix de l'agent, champ prompt, sortie streaming, vue diff du dernier run, historique avec annulation, panneau de styles rapides, liste des overrides overlay pour l'URL courante.
- **Service worker**: relais des messages content script ↔ side panel, ouverture du side panel au clic sur l'icône, stockage des overrides (`chrome.storage.local`).

### 3.2 Serveur local (`packages/server`)

- Démarré par `npx vizion` dans le dossier du projet. Écoute sur `127.0.0.1:7331` (configurable).
- Endpoints: `GET /health` (version, cwd, agents disponibles), `GET /pair?c=<code>` (page d'appairage), WebSocket `/ws` pour les sessions d'édition.
- **Appairage**: `vizion` affiche au démarrage une URL `/pair?c=<code>`. La page sert le jeton, le port, le chemin du projet et la version dans une balise `<script type="application/json">`; le content script la lit et l'enregistre comme appairage *en attente*, que le panneau fait confirmer à l'utilisateur. Le contenu d'une page n'étant jamais fiable, la lecture exige quatre conditions: code correct (comparaison à temps constant), document de premier niveau (avec `X-Frame-Options: DENY`, pour qu'une page distante ne puisse pas encadrer l'URL et récolter le jeton), origine loopback, et validation de tous les champs. La confirmation nomme le dossier du projet: une charge forgée ne peut au pire que déclencher une invite pour un projet que l'utilisateur ne reconnaît pas. Le collage manuel du jeton reste un repli.
- **AgentRunner** (interface): `run(request) → AsyncIterable<AgentEvent>`. Deux implémentations:
  - `CodexRunner`: lance `codex` en mode non interactif (`codex exec`), lit stdout en streaming.
  - `ClaudeRunner`: lance `claude -p --output-format stream-json`, lit les événements.
- **Diff et annulation**: avant de lancer l'agent, le serveur prend un instantané (`git status --porcelain` + contenu des fichiers déjà modifiés ou non suivis). Après, il compare, envoie au panneau un diff limité aux fichiers touchés, et enregistre le run dans l'historique avec l'état byte-exact avant/après de chaque fichier et le `HEAD` d'avant le run. Annuler restaure ce « avant » et, si l'agent a commité pendant le run, ramène d'abord `HEAD` (`git reset --mixed`). Si un fichier touché ne correspond plus à ce que le run avait laissé, rien n'est écrit et le serveur renvoie `undo-conflict` avec la liste; `force` annule quand même. Un formateur au save est une cause aussi probable qu'une vraie édition, et seul l'utilisateur peut les distinguer.
- **Permissions des agents**: les CLIs sont lancés en mode édition automatique (`codex exec --full-auto`, `claude -p --permission-mode acceptEdits`), sans quoi l'exécution bloque sur une confirmation interactive. Le garde-fou n'est donc pas une validation préalable — elle arriverait trop tard — mais git plus l'annulation.
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
6. À la fin, le serveur envoie le `git diff` et enregistre le run dans l'historique. Le panneau affiche ce qui a changé; le hot reload du dev server a déjà rafraîchi la page.
7. Si le résultat ne convient pas: « Annuler ce run » depuis l'historique.

## 5. Jalons

État au 2026-09-19: les jalons 1 à 7 sont mergés sur `main` (PR #1), suivis de trois blocs supplémentaires mergés séparément : multi-sélection, historique annuler / refaire et annulation d'un run accepté (PR #2) ; agent en mode Overlay qui propose des overrides (PR #3) ; capture d'écran de l'élément jointe au prompt (PR #4). L'édition inline se déclenche par le bouton « Modifier le texte » du panneau (pas par double-clic). Le runner Codex est écrit d'après la documentation du CLI et la revue Codex a validé l'option hors dépôt git, mais aucun run réel n'a été exécuté contre le binaire.

| # | Jalon | Livrable | Sub-agents |
|---|---|---|---|
| 1 | Squelette monorepo | pnpm workspace, TS strict, WXT + React, extension « hello » chargeable dans Edge et Chrome, serveur `/health`, vitest | Sonnet |
| 2 | Sélection d'élément | Overlay hover/clic, `ElementContext` extrait, affiché dans le side panel | Sonnet |
| 3 | Serveur + runners | WebSocket dans le side panel, `AgentRunner`, `CodexRunner`, `ClaudeRunner`, streaming vers le panneau | Sonnet (serveur), Haiku (vue streaming) |
| 4 | Diff + annulation | Instantané, diff des fichiers touchés, vue diff, restauration depuis l'historique | Sonnet |
| 5 | Mode overlay | Overrides DOM/CSS persistés par URL, ré-application au chargement (MutationObserver), liste dans le panneau | Sonnet |
| 6 | Édition inline + styles rapides | Double-clic texte, panneau couleur / taille / marge, génère un override (overlay) ou un prompt agent (source) | Haiku, spec fournie |
| 7 | Finition | README d'installation Windows/macOS, paquet publiable, tests de bout en bout sur Edge et Chrome | Sonnet (tests), Haiku (README) |

Dépendances: 2 dépend de 1. Les jalons 3 → 4 et 5 → 6 sont deux chaînes indépendantes qui partent de 2 et peuvent avancer en parallèle. 7 dépend de tout.

Chaque jalon = un commit revu sur la branche de travail avant le suivant.

## 6. Risques et points ouverts

- **Précision du « l'agent trouve lui-même le fichier »**: sur un gros projet, l'agent peut se tromper de fichier. Atténuation: on inclut le chemin DOM complet et les classes, et on ajoute plus tard les source maps React (`data-source` / `__reactFiber` `_debugSource`) si disponibles.
- **Format de sortie des CLIs**: `codex exec` et `claude -p --output-format stream-json` évoluent. Le runner isole ça derrière l'interface.
- **Sécurité du serveur local**: écoute seulement sur `127.0.0.1`, vérifie l'origine `chrome-extension://<id>` des connexions WebSocket, et exige le jeton d'appairage. `/health` ne renvoie plus d'en-tête `Access-Control-Allow-Origin`, pour qu'une page quelconque ouverte dans le navigateur ne puisse pas relire le `cwd` du projet ni la liste des agents installés.
- **Perte de travail sur un run**: le message `cancel` interrompt le run en vol; un délai (10 min par défaut, `runTimeoutMs`) l'interrompt tout seul pour qu'un agent bloqué ne garde pas l'`OpLock` indéfiniment; et ce qu'un run a écrit est enregistré dès la fin du run sous `~/.vizion/history/<empreinte du projet>/`, donc annulable après fermeture du panneau comme après redémarrage du serveur. Seules les métadonnées restent en mémoire: le contenu avant/après des fichiers est relu sur disque au moment d'annuler, et 50 runs par projet sont conservés. Si l'écriture échoue (disque plein, dossier illisible), le run est signalé comme appliqué mais non annulable plutôt que de le laisser croire le contraire.
- **Mode overlay sur sites tiers**: certains sites ont un CSP strict ou re-rendent le DOM (React) et écrasent les overrides. Atténuation: MutationObserver qui ré-applique.
