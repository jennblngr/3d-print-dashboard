# AGENTS.md — Brief de ce projet

## Le projet
- Ce que fait le produit : une petite application web installable sur téléphone
  pour suivre mon stock de bobines de filament (ajout par scan du code-barres ou
  du tag RFID) et pour facturer à mes proches les impressions 3D qu'ils me
  demandent, au coût du filament utilisé. Ils peuvent aussi me demander des
  impressions via une liste de souhaits.
- Pour qui : moi seul pour le stock et la gestion ; mon cercle privé (famille,
  amis) pour la partie partagée, chacun avec son lien d'invitation.
- Ce que je ne veux jamais casser :
  1. les montants dus par chaque personne ;
  2. le cloisonnement : chaque personne ne voit que ses propres données ;
  3. le stock de bobines et les poids restants.

## Langue
- On se parle en français. Mais le CODE — noms de variables, de fichiers,
  commentaires — s'écrit EN ANGLAIS. Ne code jamais en français parce qu'on
  discute en français.
- Même règle sur le dépôt : commits, titres d'issues et de pull requests en
  anglais.
- L'interface de l'application existe en français et en anglais : tout nouveau
  texte affiché doit être ajouté dans les deux langues.

## Comment je veux qu'on travaille
- Je pilote ce projet SANS lire le code. Je supervise le produit, pas les
  fichiers.
- Applique les meilleures pratiques par défaut, même si je ne les demande pas.
- Quand une tâche est finie, dis-moi précisément quoi tester à la main, comme
  un utilisateur.
- Va droit au but : pas de pédagogie non demandée. Je poserai mes questions
  quand quelque chose me perdra.
- Annonce ton plan et attends mon accord uniquement sur les chantiers qui
  risquent de casser les trois points critiques ci-dessus, ou qui changent la
  structure de la base de données.

## Commits
- Le projet est un dépôt git, poussé sur GitHub (dépôt public).
- Fais TOUJOURS des commits au format conventional commits (`feat:`, `fix:`,
  `refactor:`, `docs:`, `chore:`, `feat!:` / `BREAKING CHANGE:`), en anglais,
  à chaque tâche terminée. Je n'en écrirai jamais un moi-même.
- AVANT chaque commit, demande-moi si je veux y inclure autre chose ou si on en
  reste là.
- Les commits sont signés avec mon adresse `jennblngr@gmail.com` (réglée pour ce
  dépôt uniquement). N'ajoute jamais de mention « Co-Authored-By: Claude » ni
  de signature d'outil dans les commits ou les pull requests.

## RÈGLE VIVANTE
Chaque fois qu'une ligne de ce fichier me gêne à l'usage — trop de questions,
pas assez, du jargon, des explications inutiles — je te demande de la modifier
ici, et tu t'y tiens ensuite. Ce brief s'ajuste à moi, pas l'inverse.
Quand je corrige une de tes habitudes, propose-moi de noter cette préférence
ici pour les prochaines sessions.
N'inscris jamais de secret dans ce fichier (mot de passe, lien d'invitation,
clé d'accès).

## Garde-fous — demande-moi TOUJOURS avant de :
- toucher à la connexion du propriétaire, à son mot de passe ou aux liens
  d'invitation ;
- toucher au calcul des montants dus ou aux paiements enregistrés ;
- supprimer des données, des fichiers, ou faire une action irréversible ;
- modifier la structure de la base d'une façon qui pourrait perdre des données ;
- déployer en production ;
- ajouter un service externe ou une dépendance ;
- agir sur GitHub ailleurs que dans le dépôt de ce projet
  (`jennblngr/3d-print-dashboard`), même si l'accès configuré le permet.
Dans ces cas : explique-moi le risque en langage simple, propose, et attends
que je valide.

## La ligne rouge — sécurité non négociable
Ce produit doit, en permanence, respecter ces règles. Si tu vois que l'une
d'elles est violée, préviens-moi immédiatement.
1. Tout ce qui circule entre les utilisateurs et le produit est chiffré (HTTPS).
2. Les mots de passe ne sont jamais lisibles par personne, même moi.
3. Personne ne peut parler directement à la base de données (pas d'injection).
4. Chaque personne ne voit et ne modifie QUE ses propres données — même en
   trichant sur un identifiant.
5. Les clés d'accès ne partent jamais vers le navigateur de l'utilisateur.
6. Chaque action a une limite de fréquence.
7. Les sauvegardes existent et ont été testées au moins une fois.
8. Rien de ce qui servait à tester ne reste ouvert en production (pas de
   données de test, pas de compte de démo).

Écarts connus à corriger (constatés le 12/10/2026) :
- Règle 7 : sauvegardes automatiques en place et restauration testée sur le Mac,
  mais pas encore sur le VPS ; aucune copie hors du serveur (si le VPS est
  perdu, les sauvegardes le sont aussi).

## Conventions et décisions prises
- Aucune dépendance et aucune étape de build : Node 24 et sa base SQLite
  intégrée, interface en JavaScript simple.
- Hébergement sur mon VPS, dans `/var/www/3d-print-dashboard`, avec Docker.
  Le serveur héberge d'autres projets : l'application n'écoute que sur le
  serveur lui-même (port 3020) et c'est le Nginx déjà en place, avec certbot,
  qui la publie en HTTPS sur `3d-print-dashboard.jennblngr.com`. Ne jamais
  toucher aux fichiers ni aux conteneurs des autres projets du serveur.
- Sur le VPS, tu n'as pas d'accès direct : donne-moi les commandes en blocs à
  copier, une étape à la fois, en précisant l'utilisateur (`ubuntu` pour tout
  ce qui demande `sudo` ou Docker), et je te colle le résultat.
- Le mot de passe du propriétaire n'est jamais enregistré : seule son empreinte
  l'est. On le définit ou on le change avec la commande `npm run set-password`.
- Limites de fréquence par visiteur : 300 requêtes par minute, dont 60
  modifications ; 10 mots de passe faux bloquent la connexion 15 minutes.
- Sauvegardes automatiques de la base à chaque démarrage et une fois par jour,
  vérifiées, conservées 14 jours sur le serveur. Restauration avec
  `npm run restore` ; la base remplacée est toujours gardée de côté.
- Les proches n'ont pas de compte : un lien d'invitation privé par personne,
  remplaçable par le propriétaire.
- Les montants sont stockés en centimes. Le coût d'une impression est figé au
  moment où elle est enregistrée ; il ne change pas si la bobine est modifiée
  ou supprimée ensuite.
- Coût = grammes × prix de la bobine ÷ poids de la bobine, plus un ajustement
  manuel. Ni électricité ni usure machine.
- Une impression ne se modifie pas : on la supprime et on la ressaisit.
- Le code-barres désigne un produit (partagé par plusieurs bobines) ; le tag
  RFID désigne une seule bobine.
- Tags TigerTag : un navigateur ne peut pas les lire (format brut, pas NDEF).
  L'application sait décoder leur contenu, avec les tables publiques TigerTag
  embarquées (aucun service en ligne appelé). La lecture de la puce passera
  par une petite application Android « passerelle », installée sur mon
  téléphone uniquement, qui ouvre l'application web avec les données lues.
  Ne jamais écrire sur un tag TigerTag. Le dashboard n'a plus de bouton
  « Scanner un tag RFID » : on approche simplement la bobine du téléphone.
- Pas de recherche en ligne des codes-barres pour l'instant : l'application
  mémorise elle-même les produits déjà saisis.
- Type de filament (silk, matte...) : champ libre, vide = normal.
- Toute évolution de la base doit convertir les données existantes au
  démarrage, sans rien perdre.
- Demande-moi de tenir cette liste à jour.

## Où on en est
- Fait : application en ligne sur `https://3d-print-dashboard.jennblngr.com`
  (HTTPS vérifié le 12/10/2026) ; corrections de sécurité testées sur mon Mac.
- Fait : passerelle Android « 3D Prints NFC » (dossier `android/`) installée
  sur mon Pixel et validée le 12/10/2026 sur deux bobines TigerTag
  différentes. Elle se construit avec `sh android/build.sh` et s'installe par
  câble avec `adb install -r`.
- Prochaines étapes :
  1. suite du test en conditions réelles : scan du code-barres à la caméra,
     lien d'invitation ouvert par un proche, restauration d'une sauvegarde
     sur le VPS ;
  2. copie des sauvegardes hors du VPS (choix à faire) ;
  3. amélioration du design.
