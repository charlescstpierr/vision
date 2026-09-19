# Vizion

Modifie des sites web en direct depuis Microsoft Edge ou Chrome avec un agent de code : démarre le serveur local, sélectionne un élément, décris le changement, puis accepte ou rejette le diff.

## Comment ça marche

1. Démarre le serveur local Vizion dans le dossier de ton projet (ignore cette étape pour le mode Overlay).
2. Ouvre la page dans Edge ou Chrome (depuis ton serveur de dev ou n'importe quel site).
3. Clique sur l'icône de la barre d'outils pour ouvrir le panneau latéral Vizion.
4. Clique sur « Sélectionner un élément », puis clique sur l'élément à modifier.
5. Décris le changement dans l'invite, choisis un agent, et envoie. Le résultat s'affiche en direct, révise le diff, puis accepte ou rejette.

**Deux modes :**

- **Mode Source** : Serveur démarré, page servie par ton serveur de dev (localhost). L'agent modifie les fichiers de ton projet, en trouvant le bon fichier source par le contexte.
- **Mode Overlay** : Aucun serveur, ou n'importe quel site dont tu n'as pas le code source. Tes modifications rapides (texte, styles) sont enregistrées comme des overrides dans l'extension, par URL de page, et réappliquées à chaque chargement. Aucun agent n'est impliqué.

## Prérequis

- Node.js 22+
- pnpm 10+
- Microsoft Edge ou Chrome
- Au moins un CLI d'agent sur le PATH : `codex` ou `claude`

Les agents fonctionnent en mode auto-edit (la boîte de dialogue Accepter/Rejeter du diff est le garde-fou) ; gère les changements avec git.

## Installation

Clone le dépôt et installe les dépendances :

```sh
git clone https://github.com/charlescstpierr/vision.git
cd vision
pnpm install
pnpm -r build
```

**Charger l'extension :**

- **Edge** : Ouvre `edge://extensions`, active le mode développeur, clique sur « Charger l'extension non empaquetée », sélectionne `packages/extension/.output/chrome-mv3`.
- **Chrome** : Ouvre `chrome://extensions`, active le mode développeur, clique sur « Charger l'extension non empaquetée », sélectionne `packages/extension/.output/chrome-mv3`.

Pour une build spécifique à Edge, lance `pnpm --filter @vizion/extension build:edge` (produit dans `.output/edge-mv3`).

## Démarrer le serveur local

Depuis le dossier de ton projet :

```sh
node /path/to/vizion/packages/server/dist/cli.js
```

Ajoute l'option `--port` pour changer le port (7331 par défaut).

Une fois publié sur npm, utilise :

```sh
npx @charlescstpierr/vizion
```

Le serveur affiche les agents détectés et se lie uniquement à `127.0.0.1`, acceptant les connexions WebSocket de l'extension.

## Aider l'agent à trouver le fichier (optionnel)

Dans un projet Vite + React, ajoute le plugin à `vite.config.ts` (dev seulement, protégé par `command`) :

```ts
export default defineConfig(({ command }) => ({
  plugins: [react({ babel: { plugins: command === 'serve' ? ['@charlescstpierr/vizion-babel-plugin-source'] : [] } })],
}));
```

Installe-le comme dépendance de dev :

```sh
npm i -D @charlescstpierr/vizion-babel-plugin-source
```

Il annote chaque élément hôte JSX (`div`, `button`, ...) avec un attribut `data-vizion-source="file:line:column"`. Vizion le lit depuis l'élément sélectionné (ou son ancêtre annoté le plus proche) et le transmet à l'agent, pour qu'il commence au bon fichier plutôt que de deviner à partir du DOM.

## Utilisation

1. Ouvre le panneau latéral (clique sur l'icône de la barre d'outils).
2. La ligne de statut affiche « Mode Source » (serveur + localhost) ou « Mode Overlay » (aucun serveur).
3. Clique sur « Sélectionner un élément » et clique sur l'élément à modifier.
4. La carte d'élément affiche le sélecteur, le chemin DOM et les styles calculés.
5. Modifications rapides : bouton « Modifier le texte », lignes couleur/taille/marge, ou écris une invite complète.
6. Choisis un agent (Codex ou Claude), puis « Envoyer à l'agent ».
7. Regarde le résultat s'afficher en direct dans le panneau.
8. Une fois terminé, révise le diff, clique sur « Accepter » ou « Rejeter ».

## Notes Windows et macOS

- **Windows** : Le serveur cherche `codex.cmd` et `claude.cmd` sur le PATH.
- **macOS** : Assure-toi que les CLI d'agent sont sur le PATH du shell depuis lequel tu démarres le serveur. Si tu les as installés via Homebrew ou manuellement, ajoute le dossier bin à ton profil de shell (par ex. `.zshrc` ou `.bash_profile`).

## Développement

```sh
pnpm -r test         # Lance tous les tests
pnpm -r typecheck    # Vérifications TypeScript
pnpm -r lint         # ESLint
pnpm --filter @vizion/extension dev  # Mode dev WXT (reconstruction auto)
```

Architecture et plan de mise en œuvre : [docs/PLAN.md](docs/PLAN.md)

## Dépannage

| Problème | Solution |
|-------|----------|
| « Serveur non démarré » dans le panneau latéral | Démarre le serveur (voir « Démarrer le serveur local »), vérifie que le port 7331 est libre, ou passe `--port`. |
| « Recharge la page pour activer Vizion dessus. » | Le content script ne s'est pas chargé. Recharge la page, ou réinstalle l'extension. |
| Aucun agent détecté | Installe le CLI `codex` ou `claude`, vérifie qu'il est sur le PATH, redémarre le serveur. |
| Rejeter ne fait rien, diff vide | Les fonctionnalités de diff et de rejet nécessitent que ton projet soit un dépôt git. |
| Le mode Overlay ne persiste pas | Certains sites ont une Content Security Policy stricte ou re-rendent le DOM ; les overrides peuvent ne pas survivre. |
