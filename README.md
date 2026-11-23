# ALERTES

Planisphère des veilles du jour : les événements en cours dans chaque pays, présentés dans une interface type « jumeau numérique ».

Ce n’est **pas** un système d’alerte officielle. Les données viennent de sources publiques et peuvent être incomplètes ou en retard. En cas d’urgence, suivez les autorités locales.

## Ouvrir

```bash
cd /workspace/alertes/app
python3 -m http.server 8766
```

Puis [http://localhost:8766](http://localhost:8766). Un serveur local est nécessaire (chargement de la carte et des bibliothèques).

Aperçu en ligne : [https://yannickekoule-coder.github.io/alertes/](https://yannickekoule-coder.github.io/alertes/)

## Effet

Au chargement, un globe filaire apparaît dans une lentille cyan (anneau, graduations, arcs). Le globe reste en 3D et tourne seul (un tour en 60 secondes, comme dans Cerveau virtuel) : on le glisse dans tous les sens, on pince ou on utilise la molette pour zoomer. Atmosphère cyan lumineuse, frontières blanc/cyan, terres en points, halos selon la gravité (vert = info, ambre = vigilance, rouge = danger) et anneaux radar. Un clic sur un pays ou une carte d’alerte fait voler la caméra jusqu’au pays, puis la vue bascule sur une carte réelle (satellite Esri World Imagery, ou plan OpenStreetMap) centrée sur l’alerte, avec le signal pulsé à l’emplacement exact et les villes en relief. Chaque carte d’alerte propose aussi « Ouvrir dans Google Maps ». Le bouton « Retour au globe » ramène à la rotation. Les panneaux HUD montrent le fil d’alertes, les compteurs, les sources et la chronologie du jour (heure de Paris). Un clic ou un appui sur un pays rapproche la caméra et affiche ses cartes. Sur téléphone, les panneaux deviennent un tiroir bas. Si WebGL manque, une carte 2D prend le relais. Les animations se calment automatiquement si le système demande `prefers-reduced-motion`.

Ajouter `?shot=1` à l’adresse saute l’intro (utile pour une capture).

## Sources (sans clé, lues depuis le navigateur)

- **USGS** — séismes de magnitude ≥ 4,5 des dernières 24 heures (GeoJSON).
- **GDACS** — catastrophes naturelles en cours (séismes, inondations, cyclones, volcans, sécheresses, feux).
- **NASA EONET** — événements naturels ouverts, retenus s’ils ont été actualisés dans les 7 derniers jours.

Chaque alerte est rattachée à un pays par ses coordonnées (et par les codes pays fournis par GDACS). Aucune alerte n’est inventée : si une source ne répond pas, elle est indiquée comme indisponible, et le dernier jeu réussi peut être relu depuis un cache local.

Carte de fond : [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth, 1:110m). Rendu 3D : Three.js r159, fourni avec l’application.

## Fichiers à déposer dans un projet Claude « ALERTES »

Fichiers principaux uniquement, sans les bibliothèques tierces ni les données Natural Earth :

- `index.html`
- `css/alertes.css`
- `js/geo.js`
- `js/data.js`
- `js/alertes.js`
- `js/map.js`
- `README.md`
- `assets/favicon.svg`
- `data/iso.json`
- `data/cities.json` (extrait des villes, utile)
