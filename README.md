# Vizion

Modifie des sites web en direct depuis Microsoft Edge ou Chrome avec un agent de code : démarre le serveur local, sélectionne un élément, décris le changement. L'agent écrit les modifications sur disque immédiatement ; consulte l'historique pour annuler le dernier run si besoin.

## Comment ça marche

1. Démarre le serveur local Vizion dans le dossier de ton projet (ignore cette étape pour le mode Overlay).
2. Ouvre la page dans Edge ou Chrome (depuis ton serveur de dev ou n'importe quel site).
3. Clique sur l'icône de la barre d'outils pour ouvrir le panneau latéral Vizion.
4. Clique sur « Sélectionner un élément », puis clique sur l'élément à modifier.
5. Décris le changement dans l'invite, choisis un agent, et envoie. Le résultat s'affiche en direct ; le diff est appliqué immédiatement sur disque et ton serveur de dev recharge la page.

**Deux modes :**

- **Mode Source** : Serveur démarré, page servie par ton serveur de dev (localhost). L'agent modifie les fichiers de ton projet, en trouvant le bon fichier source par le contexte.
- **Mode Overlay** : Aucun serveur, ou n'importe quel site dont tu n'as pas le code source. Tes modifications rapides (texte, styles) sont enregistrées comme des overrides dans l'extension, par URL de page, et réappliquées à chaque chargement. Sans serveur, aucun agent n'est impliqué ; avec le serveur démarré sur une page distante, l'agent peut proposer des overrides que tu appliques ou ignores.

## Prérequis

- Node.js 22+
- pnpm 10+
- Microsoft Edge ou Chrome
- Au moins un CLI d'agent sur le PATH : `codex` ou `claude`

Les agents fonctionnent en mode auto-edit : les fichiers sont modifiés directement sur disque. Gère les changements avec git ; l'annulation depuis l'Historique du panneau est ton garde-fou principal.

## Installation

Clone le dépôt et installe les dépendances :

```sh
git clone https://github.com/charlescstpierr/vision.git
cd vision
pnpm install
pnpm -r build
```

**Charger l'extension :**

À chaque tag `v*`, la CI publie une GitHub Release avec les archives pré-compilées. **Aucune release n'existe pour le moment** : en attendant, compile depuis les sources (voir ci-dessous).

Quand une release sera disponible :
1. Va sur la page [Releases](https://github.com/charlescstpierr/vision/releases).
2. Télécharge `vizion-extension-chrome-<version>.zip` (Chrome) ou `vizion-extension-edge-<version>.zip` (Edge).
3. Décompresse l'archive.
4. Ouvre `edge://extensions` (Edge) ou `chrome://extensions` (Chrome), active le mode développeur.
5. Clique sur « Charger l'extension non empaquetée », sélectionne le dossier décompressé.

**Depuis les sources :**

- **Edge** : Lance `pnpm --filter @vizion/extension build:edge` (produit dans `.output/edge-mv3`), puis ouvre `edge://extensions`, active le mode développeur, clique sur « Charger l'extension non empaquetée », sélectionne ce dossier.
- **Chrome** : Lance `pnpm -r build`, puis ouvre `chrome://extensions`, active le mode développeur, clique sur « Charger l'extension non empaquetée », sélectionne `packages/extension/.output/chrome-mv3`.

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

**Appairage.** Au démarrage, le serveur affiche une URL d'appairage (le jeton sous-jacent reste conservé dans `~/.vizion/token`) :

```
Appairage — ouvre cette URL dans le navigateur où Vizion est installé :
  http://127.0.0.1:7331/pair?c=<code>
```

1. Ouvre cette URL dans le navigateur où l'extension est installée. La page affiche le chemin du projet et le port.
2. L'extension détecte cette page automatiquement. Ouvre le panneau latéral Vizion : tu verras un encadré « Appairer Vizion ? » avec les détails du projet et du serveur.
3. Clique « Appairer ». C'est tout.

**Sécurité :**
- Le code `c=` dans l'URL n'est connu que de ton terminal et change à chaque redémarrage du serveur.
- L'extension n'accepte cette page que si elle provient de `127.0.0.1`/`localhost` et qu'elle est la page principale de l'onglet (pas dans une iframe).
- La confirmation dans le panneau te permet de vérifier le chemin du projet avant que l'extension ne commence à communiquer avec le serveur.

**Alternative (manuel) :** Si tu préfères ou en cas de problème, tu peux aussi ouvrir la section « Réglages » du panneau latéral et coller manuellement le jeton d'appairage affiché au démarrage du serveur.

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
4. La carte d'élément affiche le sélecteur de l'élément retenu. Le reste du contexte (chemin DOM, classes, styles calculés) part à l'agent sans t'encombrer l'écran.
5. Modifications rapides : bouton « Modifier le texte », lignes couleur/taille/marge, ou écris une invite complète. En mode Overlay, chaque modification devient un override ; « Annuler » / « Refaire » dans la section Historique.
6. « Envoyer à l'agent » (ou Ctrl/Cmd + Entrée). Si plusieurs agents sont détectés, un sélecteur te laisse choisir ; s'il n'y en a qu'un, il est utilisé directement. Une capture de l'élément part automatiquement avec la demande, pour que l'agent voie le rendu ; si la capture échoue, le run part quand même sans image.
7. Regarde le résultat s'afficher en direct dans le panneau. Le bouton « Arrêter » interrompt l'agent en cours : le diff de ce qu'il a déjà écrit arrive quand même, donc un run interrompu reste visible et annulable depuis l'Historique. Un run qui dépasse 10 minutes est interrompu de la même façon.
8. En mode Source : le diff s'affiche et est déjà appliqué sur disque. Consulte l'historique pour voir les runs exécutés. Seul le run le plus récent peut être annulé via « Annuler ce run » — si un fichier a changé depuis (formateur au save, édition manuelle), un bouton « Annuler quand même » te laisse confirmer (l'annulation défait aussi tout commit que le run aurait créé). L'historique est conservé sur disque, sous `~/.vizion/history/`, et survit donc au redémarrage du serveur. Les 50 derniers runs par projet sont gardés ; au-delà, les plus anciens sont supprimés.
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
| « Serveur non démarré » dans le panneau latéral | Démarre le serveur (voir « Démarrer le serveur local »), vérifie l'appairage depuis le panneau latéral et que le port correspond. |
| « Recharge la page pour activer Vizion dessus. » | Le content script ne s'est pas chargé. Recharge la page, ou réinstalle l'extension. |
| Aucun agent détecté | Installe le CLI `codex` ou `claude`, vérifie qu'il est sur le PATH, redémarre le serveur. |
| Aucun run dans l'historique après une modification | Le diff et l'annulation nécessitent que ton projet soit un dépôt git. Hors dépôt git, l'agent modifie bien les fichiers, mais Vizion ne peut ni les lister ni les restaurer. |
| Le mode Overlay ne persiste pas | Certains sites ont une Content Security Policy stricte ou re-rendent le DOM ; les overrides peuvent ne pas survivre. |
| « Run interrompu : délai de 10 min dépassé. » | L'agent a dépassé la limite et a été arrêté pour ne pas bloquer le projet. Révise le diff partiel, puis relance avec une demande plus étroite. |
| « Run appliqué, mais non enregistré dans l'historique » | Vizion n'a pas pu écrire sous `~/.vizion/history/` (disque plein, dossier en lecture seule). Les modifications de l'agent sont bien sur disque, mais ce run n'est pas annulable depuis le panneau : reviens en arrière avec git. |
| « N fichier(s) modifié(s) depuis ce run » | Un fichier touché par le run a changé après (formateur au save, édition manuelle, etc.). Clique « Annuler quand même » pour forcer l'annulation, sinon restaure le fichier et réessaye. |
| Code d'appairage invalide | Le code `c=` change à chaque démarrage du serveur. Utilise l'URL affichée par le serveur en cours d'exécution, pas une ancienne. |
| La page d'appairage reste sur « En attente de l'extension… » | L'extension n'est pas installée dans ce navigateur, ou la page a été ouverte avant son installation. Recharge la page. |
