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
- **Mode Overlay** : Aucun serveur, ou n'importe quel site dont tu n'as pas le code source. Tes modifications rapides (texte, styles) sont enregistrées comme des overrides dans l'extension, par URL de page, et réappliquées à chaque chargement. Sans serveur, aucun agent n'est impliqué ; avec le serveur démarré sur une page distante, l'agent peut proposer des overrides que tu appliques ou ignores.

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

Le serveur affiche les agents détectés et se lie uniquement à `127.0.0.1`.

**Appairage.** Au démarrage, le serveur affiche un jeton d'appairage (conservé dans `~/.vizion/token`). Ouvre la section « Réglages » du panneau latéral, colle le jeton, et ajuste le port si tu as utilisé `--port`. C'est à faire une seule fois : sans ce jeton, aucune extension ne peut parler au serveur.

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
2. La ligne de statut affiche « Mode Source » (serveur + page locale) ou « Mode Overlay » (aucun serveur, ou page distante).
3. Clique sur « Sélectionner un élément » et clique sur l'élément à modifier. Pour en choisir plusieurs, fais Maj+clic dès le premier élément : le mode sélection reste actif tant que tu tiens Maj ; un clic simple sélectionne et quitte le mode (reclique sur « Sélectionner un élément » pour en ajouter ensuite).
4. La carte d'élément affiche le sélecteur, le chemin DOM et les styles calculés.
5. Modifications rapides : bouton « Modifier le texte », lignes couleur/taille/marge, ou écris une invite complète. En mode Overlay, chaque modification devient un override ; « Annuler » / « Refaire » dans la section Historique.
6. Choisis un agent (Codex ou Claude), coche « Joindre une capture de l'élément » si tu veux que l'agent voie le rendu (premier clic : capture mise en attente, second clic : envoi), puis « Envoyer à l'agent ».
7. Regarde le résultat s'afficher en direct dans le panneau. Le bouton « Arrêter » interrompt l'agent en cours : le diff de ce qu'il a déjà écrit arrive quand même, donc un run interrompu reste révisable et rejetable. Un run qui dépasse 10 minutes est interrompu de la même façon.
8. En mode Source : révise le diff, clique sur « Accepter » ou « Rejeter ». Un diff non décidé appartient au projet, pas au panneau : tu peux fermer le panneau latéral et le rouvrir, il te sera représenté tant que tu n'as ni accepté ni rejeté. Le dernier run accepté peut être annulé depuis l'Historique, tant que le serveur n'a pas redémarré et que les fichiers touchés n'ont pas été modifiés entre-temps (l'historique vit en mémoire et l'annulation refuse tout conflit).
9. En mode Overlay avec le serveur allumé (site distant) : l'agent propose des overrides de styles ou de texte ; « Appliquer » les pose sur la page, « Ignorer » les écarte.

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
| « Serveur non démarré » dans le panneau latéral | Démarre le serveur (voir « Démarrer le serveur local »), vérifie que le jeton d'appairage est collé dans les réglages et que le port correspond. |
| « Recharge la page pour activer Vizion dessus. » | Le content script ne s'est pas chargé. Recharge la page, ou réinstalle l'extension. |
| Aucun agent détecté | Installe le CLI `codex` ou `claude`, vérifie qu'il est sur le PATH, redémarre le serveur. |
| Rejeter ne fait rien, diff vide | Les fonctionnalités de diff et de rejet nécessitent que ton projet soit un dépôt git. |
| Le mode Overlay ne persiste pas | Certains sites ont une Content Security Policy stricte ou re-rendent le DOM ; les overrides peuvent ne pas survivre. |
| « Run interrompu : délai de 10 min dépassé. » | L'agent a dépassé la limite et a été arrêté pour ne pas bloquer le projet. Révise le diff partiel, puis relance avec une demande plus étroite. |
| « Accepte ou rejette d'abord les modifications en attente. » | Un diff d'un run précédent attend toujours ta décision. Rouvre le panneau : il te sera représenté à la connexion. |
| Un diff en attente disparaît quand même | Il survit à la fermeture du panneau, mais pas au redémarrage du serveur. Décide avant d'arrêter `vizion`, ou reviens en arrière avec git. |
