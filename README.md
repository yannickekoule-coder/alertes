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

Au chargement, un globe filaire apparaît dans une lentille cyan (anneau, graduations, arcs). Le globe reste en 3D et tourne seul (un tour en 60 secondes, comme dans Cerveau virtuel) : on le glisse dans tous les sens, on pince ou on utilise la molette pour zoomer. Atmosphère cyan lumineuse, frontières blanc/cyan, terres en points, halos selon la gravité (vert = info, ambre = vigilance, rouge = danger) et anneaux radar. Un clic sur un pays ou une carte d’alerte fait voler la caméra jusqu’au pays, puis la vue bascule sur une carte réelle façon Google Earth : satellite Esri World Imagery drapé sur un relief 3D (tuiles d’élévation Terrarium / AWS, avec ombrage), inclinaison d’environ 60°, rotation lente autour de l’alerte, et bâtiments extrudés en 3D (tuiles vectorielles OpenFreeMap / OpenMapTiles, hauteur `render_height`). Le signal pulsé de l’alerte reste visible au-dessus des bâtiments. Un interrupteur 2D / 3D permet d’aplatir la vue (sans relief ni rotation). Sur téléphone, on incline et on tourne avec deux doigts. Chaque carte d’alerte propose « Ouvrir dans Google Maps » et « Ouvrir dans Google Earth ». Le bouton « Retour au globe » ramène à la rotation. Les panneaux HUD montrent le fil d’alertes, les compteurs, les sources et la chronologie du jour (heure de Paris). Un clic ou un appui sur un pays rapproche la caméra et affiche ses cartes. Sur téléphone, les mêmes informations qu’ordinateur (compteurs, fil d’alertes, sources, catégories, chronologie, détail d’alerte, villes, liens Maps et Earth, bascule 2D/3D) restent accessibles dans un tiroir bas, avec des zones de tap d’au moins 44 px. Si WebGL manque, une carte 2D prend le relais. Les animations se calment automatiquement si le système demande `prefers-reduced-motion`.

Ajouter `?shot=1` à l’adresse saute l’intro (utile pour une capture).

## Sources (sans clé, lues depuis le navigateur)

- **USGS** — séismes de magnitude ≥ 4,5 des dernières 24 heures (GeoJSON).
- **GDACS** — catastrophes naturelles en cours (séismes, inondations, cyclones, volcans, sécheresses, feux).
- **NASA EONET** — événements naturels ouverts, retenus s’ils ont été actualisés dans les 7 derniers jours.

Chaque alerte est rattachée à un pays par ses coordonnées (et par les codes pays fournis par GDACS). Aucune alerte n’est inventée : si une source ne répond pas, elle est indiquée comme indisponible, et le dernier jeu réussi peut être relu depuis un cache local.

Carte de fond (globe) : [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth, 1:110m). Rendu du globe : Three.js r159, fourni avec l’application. Carte au sol : [MapLibre GL](https://maplibre.org/) (fourni avec l’application), imagerie [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) ou plan [OpenStreetMap](https://www.openstreetmap.org/copyright), relief [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (encodage Terrarium, héritage Mapzen), bâtiments [OpenFreeMap](https://openfreemap.org/) (schéma OpenMapTiles).

Les bâtiments 3D dépendent des données OpenStreetMap : ils sont généralement denses dans les grandes villes d’Europe, d’Amérique du Nord, du Japon et d’une partie de l’Asie et de l’Amérique latine. Ils peuvent être rares ou absents dans les zones rurales, en mer, ou dans des villes peu renseignées. Le relief, lui, est mondial.

### Tuiles 3D photoréalistes Google (optionnel)

Le rendu 3D photoréaliste de Google Earth (maillage texturé des villes) passe par l’API [Photorealistic 3D Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles) de Google Maps Platform. Cela exige une clé API avec facturation activée ; aucune clé n’est créée ni fournie ici.

Pour brancher une clé plus tard, définir avant le chargement de `js/map.js` :

```html
<script>window.ALERTES_GOOGLE_3D_TILES_KEY = "VOTRE_CLE";</script>
```

La constante `GOOGLE_3D_TILES_KEY` dans `js/map.js` la relit. L’affichage de ces tuiles n’est pas inclus (il faudrait un greffon MapLibre pour les 3D Tiles, et un compte facturé). En attendant, le lien « Ouvrir dans Google Earth » ouvre le même lieu dans Google Earth, avec une vue inclinée.

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
