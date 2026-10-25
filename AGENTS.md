# AGENTS.md — Brief de ce projet

## Le projet
- Ce que fait le produit : une petite application web installable sur téléphone
  pour enregistrer mes bobines de filament et leur prix (ajout par scan du
  code-barres ou du tag RFID) et pour facturer à mes proches les impressions 3D qu'ils me
  demandent, au coût du filament utilisé. Ils peuvent aussi me demander des
  impressions via une liste de souhaits.
- Pour qui : moi seul pour les bobines et la gestion ; mon cercle privé (famille,
  amis) pour la partie partagée, chacun avec son lien d'invitation.
- Ce que je ne veux jamais casser :
  1. les montants dus par chaque personne ;
  2. le cloisonnement : chaque personne ne voit que ses propres données ;
  3. les bobines enregistrées et leurs prix.

## Langue
- On se parle en français. Mais le CODE — noms de variables, de fichiers,
  commentaires — s'écrit EN ANGLAIS. Ne code jamais en français parce qu'on
  discute en français.
- Même règle sur le dépôt : commits, titres d'issues et de pull requests en
  anglais.
- L'interface de l'application est uniquement en français (depuis le
  24/10/2026), messages d'erreur du serveur compris. Le code et les
  commentaires restent en anglais.

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
- Chaque envoi sur `main` met le site en ligne automatiquement (voir
  `.github/workflows/deploy.yml`) : pousser équivaut à déployer en production.
  Ne pousse donc jamais sans mon accord.
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

Interdits, même si c'est techniquement possible :
- modifier les fichiers d'automatisation GitHub (`.github/workflows/`) sans
  ma demande explicite, ou les pousser toi-même : tu prépares le changement
  dans un commit, c'est moi qui le pousse ;
- utiliser ma clé SSH, ou tout accès autre que celui prévu pour toi.
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
- Node 24 et sa base SQLite intégrée. Les paquets npm sont autorisés,
  avec mon accord pour chacun ; installés dans l'image Docker par `npm ci`.
- Interface en React (dossier `client/`), construite par Vite ; l'image Docker
  la construit elle-même (depuis le 25/10/2026). Sur le Mac, `npm start`
  construit l'interface puis lance l'app.
- Hébergement sur mon VPS, dans `/var/www/3d-print-dashboard`, avec Docker.
  Le serveur héberge d'autres projets : l'application n'écoute que sur le
  serveur lui-même (port 3020) et c'est le Nginx déjà en place, avec certbot,
  qui la publie en HTTPS sur `3d-print-dashboard.jennblngr.com`. Ne jamais
  toucher aux fichiers ni aux conteneurs des autres projets du serveur.
- Sur le VPS, tu n'as pas d'accès direct : donne-moi les commandes en blocs à
  copier, une étape à la fois, en précisant l'utilisateur (`ubuntu` pour tout
  ce qui demande `sudo`), et je te colle le résultat.
- Sur le VPS, chaque projet a deux utilisateurs à lui. Pour le dashboard :
  `deploy-3d-print-dashboard` reçoit la mise en ligne de GitHub (sa clé ne
  peut lancer que `/usr/local/bin/3d-print-dashboard-deploy`), et
  `run-3d-print-dashboard` fait tourner Docker. Les conteneurs sont donc
  invisibles pour `ubuntu`, même avec `sudo docker`. Pour lire le journal de
  l'application, avec `ubuntu` :
  `sudo -u run-3d-print-dashboard sh -c 'S=/run/user/$(id -u)/docker.sock; [ -S "$S" ] && export DOCKER_HOST=unix://$S; docker logs --tail 20 3d-print-dashboard-app-1'`
- Les secrets de mise en ligne (`VPS_USER`, `VPS_SSH_KEY`...) sont propres à
  chaque dépôt, dans son environnement `production` sur GitHub. Ne jamais y
  enregistrer ceux d'un autre projet : le 12/10/2026, ceux de Scrabble mis ici
  par erreur ont fait déployer Scrabble à chaque envoi de ce dépôt. Après une
  mise en ligne, vérifier que le journal finit par `Deployed:` suivi d'un
  commit de CE dépôt.
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
- Une impression se modifie (tout : personnes, partage, date, filaments,
  grammes, ajustement) ; les montants dus sont recalculés. Le
  filament déjà utilisé garde le prix auquel il avait été facturé, même si la
  bobine a changé de prix ou a été supprimée depuis ; un filament ajouté prend
  le prix actuel de sa bobine. Le lien avec l'impression Bambu et le souhait
  est conservé.
- Une impression peut être « pour moi » (choix « Moi » dans la liste des
  personnes) : personne n'est facturé, et son coût en filament
  s'additionne dans la ligne « Moi » de l'onglet Personnes. « Moi » n'est pas
  une personne : ni lien d'invitation, ni solde, ni paiement.
- Une impression peut être partagée entre plusieurs personnes (cases à cocher,
  « Moi » compris), toujours à parts égales : chacun reçoit sa part du filament
  et du coût. La supprimer la supprime
  pour tout le monde. Un proche voit que c'est partagé, jamais avec qui.
- Une impression est d'abord associée à une ou plusieurs personnes, « à
  décider » ; je choisis ensuite, part par part, de la facturer ou de
  l'offrir, et je peux changer d'avis. Seules les parts facturées comptent
  dans les montants dus. Un proche voit ses impressions facturées et
  offertes, jamais celles encore à décider. L'onglet Personnes affiche le
  coût total des impressions de chacun, quel que soit leur état. Les
  impressions enregistrées avant cette règle sont toutes facturées.
- Pas de gestion de stock (décidé le 25/10/2026) : une bobine n'est qu'une
  référence de prix et de poids pour calculer le coût des impressions. Rien
  ne baisse quand on imprime ; plus de restant, de pesée, ni de bobine
  « sous vide ». « Terminée » sert seulement à la retirer des choix. Les
  anciens chiffres de stock restent dans la base, inutilisés.
- Une fiche par produit : scanner un code-barres déjà connu ouvre sa fiche ;
  un tag RFID ouvre la fiche qui le porte, sinon celle du même produit
  (marque, matière, type, couleur), sinon une nouvelle.
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
- Relevé automatique des impressions Bambu Lab (imprimante A1, sans AMS) : le
  serveur lit l'historique de mon compte Bambu toutes les 5 minutes et range
  chaque impression terminée dans « À attribuer ». Aucun montant n'est compté
  tant que je ne l'ai pas attribuée moi-même.
- Deux issues pour une impression relevée : attribuée (même formulaire que la
  saisie manuelle, « Moi » compris quand c'est pour moi : personne
  n'est facturé), ou ignorée. Tout est annulable. L'ancien choix « Stock seulement »
  a été retiré le 24/10/2026 ; les impressions déjà rangées ainsi restent
  annulables (bouton « Remettre »).
- Une impression ratée n'est jamais facturée : elle s'attribue uniquement à
  « Moi » (le serveur refuse toute autre personne, même en la modifiant
  ensuite), avec un poids estimé au prorata de la durée écoulée, que je peux
  corriger.
- L'historique Bambu antérieur à la connexion du compte n'est pas repris : je
  le saisis à la main. Idem pour une impression lancée par carte SD.
- La connexion à Bambu se fait par un code reçu par e-mail ; mon mot de passe
  Bambu n'est jamais demandé. La clé d'accès obtenue reste sur le serveur
  (donc aussi dans les sauvegardes) et ne part jamais vers un navigateur.
- Services externes appelés : Bambu Lab, et le service d'envoi des
  notifications du navigateur (celui de Google pour Chrome), validé le
  25/10/2026. Bambu passe par un accès non officiel qui peut cesser de
  fonctionner : la saisie manuelle doit toujours rester possible. On ne fait
  que lire le compte, jamais commander l'imprimante.
- Suivi en direct de l'imprimante (encart « En cours ») par la connexion temps
  réel de Bambu, en écoute seule : le serveur n'envoie jamais rien à
  l'imprimante, pas même une demande d'état. S'il est refusé, le relevé toutes
  les 5 minutes continue seul. Il accélère la détection des fins d'impression.
- Notifications (25/10/2026) : réservées au propriétaire, à activer sur chaque
  appareil depuis l'onglet Impressions ; fin ou échec d'une impression (un
  appui ouvre le formulaire d'attribution) et pause sur un problème. Chiffrées
  pour l'appareil : Google les transporte sans pouvoir les lire. Se
  déconnecter de l'application coupe les notifications de cet appareil.
- Chaque impression relevée garde l'image de son modèle, téléchargée une fois
  chez Bambu et servie par l'application, sans limite de durée. Les images
  manquantes sont récupérées pour les 50 dernières impressions que Bambu liste
  encore (y compris celles relevées avant l'ajout des images).
- Le formulaire d'attribution présélectionne la bobine de même matière et de
  couleur la plus proche : simple proposition, rien n'est compté avant
  validation.
- Toute évolution de la base doit convertir les données existantes au
  démarrage, sans rien perdre.
- Demande-moi de tenir cette liste à jour.

## Design
- Style « Terminal » (minimaliste, libellés en police à chasse fixe, une seule
  couleur d'accent orange), issu de Claude Design et appliqué le 25/10/2026 ;
  il remplace le style « Coton » du 13/10/2026. Les 4 onglets sont 4 panneaux :
  sur téléphone, un seul affiché et onglets en bas ; sur tablette (dès 880 px),
  onglets dans une barre latérale ; sur ordinateur (dès 1100 px), panneaux côte
  à côte, les fermés réduits à une bande avec leur nom à la verticale.
  Fenêtres qui montent du bas de l'écran (centrées sur grand écran) et
  redescendent à la fermeture ; message bref en haut. Les confirmations
  (supprimer, remplacer un lien...) passent par une fenêtre de l'app, jamais
  par celle du navigateur.
- Listes déroulantes dessinées par l'app (`client/src/Select.jsx`), identiques dans
  tous les navigateurs ; la vraie liste du navigateur reste cachée et c'est elle
  qui garde la valeur enregistrée.
- Animations courtes au changement d'onglet uniquement (pas quand la page se
  redessine après un enregistrement) : repère qui glisse sous l'onglet et
  contenu en fondu sur téléphone et tablette, panneau qui s'élargit sur
  ordinateur. Aucune animation si l'appareil demande moins de mouvements.
- Toute l'apparence passe par `client/src/style.css` et ses variables (couleurs,
  arrondis, polices) : un nouvel écran réutilise les classes existantes, sans
  style écrit à part. Espacements sur une seule échelle : 4, 8, 12, 16, 24
  et 32 px. Thèmes clair et sombre : selon le réglage de l'appareil
  par défaut, ou forcés d'un clic sur l'icône en haut (soleil et lune =
  automatique, soleil = clair, lune = sombre) ; choix propre à chaque
  appareil.
- Polices Geist et Geist Mono livrées avec l'application ; icônes Lucide (paquet
  npm `lucide-static`), servies par l'application elle-même : rien n'est chargé
  depuis un autre site.
- Le dossier `design/` (planche des écrans, brief) reste sur mon Mac et n'est
  pas dans le dépôt.

## Où on en est
- Fait : application en ligne sur `https://3d-print-dashboard.jennblngr.com`
  (HTTPS vérifié le 12/10/2026) ; corrections de sécurité testées sur mon Mac.
- Fait : passerelle Android « 3D Prints NFC » (dossier `android/`) installée
  sur mon Pixel et validée le 12/10/2026 sur deux bobines TigerTag
  différentes. Elle se construit avec `sh android/build.sh` et s'installe par
  câble avec `adb install -r`.
- Fait, en ligne depuis le 13/10/2026 : design « Coton » et nouvelles icônes,
  relevé automatique des impressions Bambu Lab, poids à deux décimales,
  impressions « pour moi » et impressions partagées entre plusieurs personnes.
  La base du VPS a été convertie sans erreur (journal vérifié).
- Prochaines étapes :
  1. tester en ligne le nouveau design, « Moi » et le partage (montants dus
     inchangés, part de chacun, page d'un proche), et connecter mon compte
     Bambu depuis l'onglet Impressions ;
  2. suite du test en conditions réelles : scan du code-barres à la caméra,
     lien d'invitation ouvert par un proche, restauration d'une sauvegarde
     sur le VPS ;
  3. copie des sauvegardes hors du VPS (choix à faire) ;
