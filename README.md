# Lapsus

Lapsus est une application web de suivi scolaire. Elle regroupe l'emploi du temps, les devoirs et les évaluations dans une interface adaptée aux ordinateurs et aux mobiles.

## Fonctionnalités

### Tableau de bord
- Résumé de la journée.
- Affichage du cours en cours et du prochain cours.
- Vue sur les devoirs à rendre le lendemain.
- Rappel des contrôles et évaluations à venir.

### Emploi du temps
- Vue hebdomadaire sur ordinateur.
- Vue journalière sur mobile.
- Navigation entre les jours et les semaines.
- Affichage des horaires, des pauses et de la pause déjeuner.
- Prise en compte des cours annulés et du cours en cours.

### Devoirs
- Ajout manuel d'un devoir.
- Association à une matière et à une date limite.
- Filtres et classement par matière.
- Suivi des devoirs terminés.

### Import des calendriers

Lapsus sait importer trois flux au format ICS :
- Emploi du temps.
- Devoirs.
- Contrôles et évaluations.

Le traitement des calendriers prend en charge :
- Les dates et les horaires.
- Les fuseaux horaires et les dates UTC.
- Les descriptions et les lieux.
- Les événements annulés.
- Les répétitions quotidiennes et hebdomadaires.
- Les exceptions aux répétitions.

L'expansion des événements récurrents est limitée à une période de 400 jours et à 1 500 occurrences.

### Compte et synchronisation
- Création de compte et connexion avec Supabase Auth.
- Sauvegarde des devoirs et de leur état dans Supabase.
- Sauvegarde des réglages utilisateur.
- Fonction de suppression de compte prévue dans l'application.

Les tables utilisées par le code sont notamment `homework`, `done_items` et `settings`.

Le projet appelle également les fonctions SQL :
- `email_exists`
- `delete_my_account`

### Personnalisation
- Thème clair.
- Thème sombre.
- Thème adapté aux réglages du système.
- Couleurs associées aux matières.

### Notifications et installation
- Rappels liés aux cours.
- Application web progressive (PWA).
- Manifeste web pour l'installation sur un appareil compatible.
- Interface adaptée aux mobiles et aux ordinateurs.

## Technologies

| Technologie | Utilisation |
| --- | --- |
| HTML | Structure des pages |
| CSS | Mise en page et apparence |
| JavaScript natif | Logique de l'application |
| Supabase | Authentification et stockage des données |
| Cloudflare Pages | Hébergement du site |
| Cloudflare Worker | Relais configuré pour récupérer les flux ICS |
| ICS | Format des calendriers importés |

Le projet n'utilise pas de framework front-end ni d'étape de compilation.

## Structure du projet

| Fichier | Rôle |
| --- | --- |
| `index.html` | Structure de l'application |
| `app.js` | Fonctionnement et logique de l'application |
| `style.css` | Styles et affichage |
| `conditions.html` | Page des conditions |
| `manifest.webmanifest` | Configuration de la PWA |
| `README.md` | Documentation du projet |

## Installation locale

1. Clone le dépôt :

   ```bash
   git clone https://github.com/nonovernaison21/mon-ent.git