/**
 * Le lexique français embarqué : les mots de BASE, jamais leurs formes.
 *
 * Ce fichier ne contient que des entrées de dictionnaire — infinitifs, singuliers
 * masculins, invariables. Les pluriels, féminins, conjugaisons et adverbes sont
 * produits par `morphology-fr.ts` : stocker les formes fléchies multiplierait ce
 * fichier par vingt pour dire ce que six règles disent déjà.
 *
 * **Le choix du vocabulaire.** Priorité au français courant (les quelques milliers
 * de mots qui font l'écrasante majorité d'un texte), complété par le vocabulaire de
 * bureau, du droit, de la gestion et de l'informatique — celui des documents que
 * les gens écrivent réellement avec une suite bureautique.
 *
 * **Ce que ce lexique n'est pas.** Il ne prétend pas à l'exhaustivité d'un
 * dictionnaire de 500 000 formes. C'est pourquoi le correcteur fonctionne par
 * défaut en mode *prudent* : un mot inconnu n'est signalé que si une correction
 * plausible existe (voir `dict/index.ts`). Un lexique partiel utilisé sans
 * précaution soulignerait le vocabulaire spécialisé de son auteur, et il cesserait
 * de le lire.
 *
 * Les listes sont des chaînes séparées par des espaces : c'est la forme la plus
 * compacte à écrire, à relire et à diffuser (un tableau JSON coûterait deux
 * caractères de ponctuation par mot).
 */

/** Découpe une liste écrite sur plusieurs lignes. */
export function words(raw: string): string[] {
 return raw.split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

// =========================================================================
// Verbes du 1er groupe (-er) — conjugués par règle
// =========================================================================

export const VERBS_ER = `
aider aimer ajouter allumer améliorer amener analyser annoncer annuler 
appeler apporter apprécier approcher approuver arranger arrêter arriver assister assurer
attacher attaquer attirer augmenter autoriser avancer avouer
baisser balayer bavarder bloquer blesser boucher bouger briller brûler
cacher calculer calmer camper casser causer céder célébrer cesser changer chanter charger
chasser chauffer chercher choquer circuler citer classer coller commander commencer
communiquer comparer compléter composer compter concerner conseiller considérer
consister consommer constater consulter contacter continuer contribuer contrôler converser
copier corriger coucher couper courber coûter créer creuser crier critiquer
cultiver danser dater décider déclarer décorer découper dédier dégager
déjeuner demander démarrer déménager démontrer dépasser dépenser déplacer
déposer déranger dériver désirer dessiner détacher détailler déterminer
détester développer deviner dicter diminuer dîner diriger discuter distinguer distribuer
diviser documenter donner doubler douter durer
échanger échapper échouer éclairer économiser écouter éditer effacer effectuer élever
éliminer éloigner emballer embaucher emmener empêcher employer emprunter encourager
enfoncer engager enlever enregistrer enseigner entamer entourer entraîner entrer envoyer
épargner espérer essayer essuyer estimer étaler étonner étudier évaluer éviter
examiner excuser exercer exiger expliquer exporter exposer exprimer
fabriquer fâcher faciliter fatiguer favoriser fermer fêter figurer filmer filtrer financer
fixer former formuler frapper fréquenter frotter fumer fusionner
gagner garder garer gaspiller générer gérer glisser gonfler goûter graver grimper gronder
grouper guider
habiller habiter hésiter heurter hisser honorer identifier ignorer illustrer imaginer
imiter implanter importer imposer imprimer improviser incliner indiquer influencer informer
inquiéter insérer insister inspirer installer intégrer 
intéresser interpréter interroger inventer inverser inviter isoler
jeter jouer juger justifier
laisser lancer laver lever libérer licencier lier limiter livrer localiser loger louer lutter
 manger manifester manipuler manquer marcher marquer masquer mélanger mener
mentionner mériter mesurer minimiser modérer modifier monter montrer motiver multiplier
naviguer négliger négocier nettoyer nommer noter notifier numéroter
observer occuper opposer optimiser ordonner organiser orienter oser oublier

paginer parler partager participer passer patienter payer pêcher pencher penser
percer persuader peser photographier piloter placer plaisanter
planifier planter pleurer plier plonger porter poser posséder poster pousser
 pratiquer précéder préciser préférer préparer présenter préserver présider prêter
 prier privilégier procéder proclamer profiter programmer
progresser prolonger promener prononcer proposer protéger prouver publier
puiser purger
qualifier questionner quitter
 raconter ranger rappeler rapporter rassembler rassurer rattraper
réaliser rechercher recommander recommencer recopier récupérer
rédiger refuser regarder régler regretter rejeter 
relever relier remarquer rembourser remercier remplacer 
rencontrer renforcer renoncer renseigner rentrer renverser renvoyer réparer 
repasser répéter reporter reposer représenter réserver résider 
respecter respirer ressembler rester restituer résumer retirer retourner retrouver
 réveiller révéler réviser risquer rouler
 saluer sauter sauvegarder sauver scanner sécher secouer sélectionner sembler
séparer serrer signaler signer signifier simplifier situer soigner solliciter sonner
 souffler souhaiter souligner soupçonner 
 stationner stocker stopper structurer substituer succéder suggérer
supporter supposer supprimer surveiller synchroniser
taper téléphoner télécharger témoigner tenter terminer tester tirer tomber
toucher tourner tousser tracer traiter transférer transformer 
transporter travailler traverser trembler tricher tromper trouver tuer
unifier utiliser exister subsister persister accuser assumer condenser répliquer
vacciner valider valoriser vanter varier veiller vérifier verser 
vider viser visiter voler voter voyager
zoomer

accepter accompagner accorder accrocher accumuler acheter achever activer actualiser adapter
additionner adhérer adopter adresser affecter afficher affirmer agiter ajuster alerter aligner
alimenter allonger allouer alterner aménager amorcer animer annexer anticiper appliquer
apposer approvisionner appuyer arbitrer archiver argumenter articuler aspirer assembler
assigner associer atténuer attester attribuer authentifier automatiser avantager aviser axer
baliser barrer basculer baser bénéficier border boucler brancher brasser brouiller
câbler cadrer canaliser capter caractériser cataloguer centraliser centrer certifier chiffrer
cibler cliquer cloner coder collaborer collecter colorer combiner commenter commercialiser
compenser compiler comprimer concentrer concrétiser condamner conditionner confectionner
conférer confier configurer confirmer conforter conjuguer connecter consacrer conserver
consolider constituer contester contourner contraster contrer converger convier convoquer
coopérer coordonner coter cotiser coupler couronner créditer croiser crypter cumuler
débiter débloquer déborder déboucher débrancher débuter décaler décharger déchiffrer
déclencher décliner décoder décomposer décompter déconnecter décrocher dédoubler défiler
déformer dégrader déléguer délibérer délimiter démarquer démonter dénombrer dénoncer dépanner
dépister déployer dérouler désactiver désigner désinstaller destiner détecter détériorer
détourner dévier dévoiler dialoguer diffuser digitaliser disposer dissiper dissocier dominer
doter dresser dupliquer dynamiser
ébaucher écarter échelonner éclater écraser édifier éduquer égaler élaborer élucider embarquer
emménager empiler encadrer encaisser enchaîner encoder endommager énumérer épingler équilibrer
équiper escompter espacer étalonner étiqueter évacuer évoluer évoquer exagérer exceller exécuter
expédier expérimenter expirer exploiter explorer
facturer falsifier familiariser fédérer fiabiliser fidéliser figer filer finaliser fonctionner
fonder forcer forger formater fractionner freiner
géolocaliser gouverner graduer gratifier greffer
habiliter harmoniser hériter hiérarchiser homologuer horodater hydrater
illuminer immobiliser implémenter impliquer imputer incarner inciter incorporer incrémenter
indemniser informatiser initialiser initier injecter innover inspecter instaurer instituer
intensifier intercaler interfacer interpeller invalider inventorier
jalonner jauger jumeler juxtaposer
labelliser légaliser libeller liquider lister
majorer mandater manœuvrer marginaliser matérialiser maximiser mémoriser migrer mobiliser
modéliser moduler mouiller muter mutualiser
nationaliser neutraliser nier niveler normaliser nuancer numériser
objecter obliger obstruer opérer orchestrer outiller
paramétrer parapher parier parrainer pénaliser pénétrer perdurer perfectionner perforer permuter
perpétuer persévérer personnaliser peupler piéger pivoter plafonner plaider plaquer pointer
polluer pomper ponctuer positionner postuler préconiser prélever présélectionner prioriser
privatiser priver procurer profiler projeter prospecter provisionner provoquer pulvériser purifier
quadriller quantifier
raccorder racheter raffiner rallier rallonger ramasser ramener rapatrier rapprocher
rationaliser rattacher raviver réactiver réactualiser réadapter réaffecter réajuster réaménager
réapprovisionner rebaptiser reboucher rebrancher recadrer recalculer recaler recentrer
recharger réchauffer réclamer recoller recomposer recompter reconfigurer reconnecter
reconstituer recouper recouvrer recruter rectifier redémarrer redistribuer redonner redoubler
redouter redresser réévaluer référencer refléter reformater reformuler régénérer réglementer
régulariser réguler réhabiliter réimprimer réinitialiser réinsérer réinstaller réintégrer
réitérer rejouer relancer relater relativiser relayer relocaliser remanier remédier remodeler
remonter renégocier renommer renouveler rénover rentabiliser réorganiser réorienter repérer
répertorier replacer replier repositionner reprogrammer requalifier résilier résister
restaurer restructurer résulter retarder retoucher retracer retraiter retrancher réunifier
réutiliser revaloriser revendiquer reverser révoquer rythmer
sacrifier sanctionner saturer sceller schématiser scinder scruter sécuriser segmenter
sensibiliser séquencer simuler solder sonder soulager soulever soumissionner sourcer
spécialiser spécifier spéculer stabiliser standardiser stériliser stimuler stipuler subdiviser
subordonner subventionner superposer superviser suppléer surcharger surclasser surestimer
surévaluer surligner surmonter surpasser susciter symboliser synthétiser systématiser
tabuler tamponner tarifer taxer télétravailler tempérer temporiser théoriser tolérer totaliser
tracter trafiquer transiter transposer trancher trier tripler troquer typer
uniformiser urbaniser
vaporiser véhiculer ventiler verbaliser verrouiller versionner virer visualiser vulgariser
zoner
`;

/**
 * Verbes du 2e groupe (-ir, participe présent en -issant).
 *
 * Distingués du 3e groupe parce que leur conjugaison est parfaitement régulière :
 * les mélanger obligerait à écrire à la main ce que six terminaisons décrivent.
 */
export const VERBS_IR2 = `
abolir aboutir accomplir accueillir adoucir affaiblir affranchir agir agrandir aplanir
appauvrir applaudir approfondir arrondir assainir assortir atterrir avertir
bannir bâtir bénir blanchir bleuir blottir bondir brandir brunir
choisir convertir
définir démolir désobéir divertir durcir
éblouir éclaircir élargir embellir enfouir engloutir enrichir envahir épaissir épanouir
établir étourdir évanouir
faiblir farcir finir fleurir fournir franchir frémir
garantir garnir gémir grandir grossir guérir
 investir jaillir jaunir
maigrir meurtrir moisir mollir mugir mûrir
noircir nourrir obéir
pâlir périr pétrir polir pourrir punir
raccourcir raffermir rafraîchir ragaillardir ralentir ramollir réagir réfléchir refroidir
régir rejaillir remplir répartir resplendir ressortir rétablir retentir réunir réussir
rôtir rougir rugir
saisir salir subir surgir
ternir trahir travestir
unir vernir vieillir vomir vrombir
`;

/**
 * Verbes du 3e groupe traités par FAMILLE (voir `morphology-fr.ts`).
 *
 * La liste est explicite, et non déduite de la terminaison, parce que « bâtir »
 * (2e groupe) et « partir » (3e) finissent tous deux par « tir » : seule
 * l'appartenance déclarée permet de trancher.
 */
export const VERBS_3 = `
abattre admettre apercevoir apparaître appartenir apprendre atteindre attendre
combattre commettre comprendre concevoir conclure conduire confondre connaître consentir
construire contenir contraindre corrompre couvrir craindre cuire
débattre décevoir découvrir décrire défendre démentir dépendre descendre desservir détenir
détruire devenir disparaître dormir écrire élire endormir entendre entreprendre
entretenir éteindre exclure fondre inclure induire inscrire instruire interdire interrompre
intervenir introduire joindre lire maintenir mentir mettre mordre nuire obtenir offrir omettre
ouvrir paraître parcourir partir parvenir peindre percevoir perdre permettre plaindre
poursuivre prendre prescrire pressentir prétendre prévenir produire promettre
recevoir reconnaître réduire rejoindre remettre rendre renaître repartir répondre
reprendre reproduire ressentir restreindre retenir revendre revenir rire rompre
courir secourir sentir servir sortir souffrir soumettre soutenir souscrire sourire
suivre surprendre survivre suspendre teindre tendre tenir tordre traduire transmettre
vendre venir vivre
correspondre fendre pondre répandre souvenir
`;

/**
 * Verbes vraiment irréguliers : leurs formes sont données, pas calculées.
 *
 * Aucune règle ne mène de « aller » à « vais » ni de « être » à « fus ». Ces
 * quelques verbes sont les plus fréquents de la langue : les manquer rendrait le
 * correcteur inutilisable, et les deviner produirait des formes inventées.
 */
export const IRREGULAR = `
être suis es est sommes êtes sont étais était étions étiez étaient étant été fus fut fûmes
fûtes furent serai seras sera serons serez seront serais serait serions seriez seraient sois
soit soyons soyez soient fusse fusses fût fussions fussiez fussent
avoir ai as a avons avez ont avais avait avions aviez avaient ayant eu eus eue eues eut eûmes
eûtes eurent aurai auras aura aurons aurez auront aurais aurait aurions auriez auraient aie
aies ait ayons ayez aient eusse eusses eût eussions eussiez eussent
aller vais vas va allons allez vont allais allait allions alliez allaient allant allé allés
allée allées allai allas alla allâmes allâtes allèrent irai iras ira irons irez iront irais
irait irions iriez iraient aille ailles aillent allasse allât
faire fais fait faisons faites font faisais faisait faisions faisiez faisaient faisant faits
faite fis fit fîmes fîtes firent ferai feras fera ferons ferez feront ferais ferait ferions
feriez feraient fasse fasses fassions fassiez fassent fisse fît
dire dis dit disons dites disent disais disait disions disiez disaient disant dite dites dits
dîmes dîtes dirent dirai diras dira dirons direz diront dirais dirait dirions diriez diraient
dise dises
voir vois voit voyons voyez voient voyais voyait voyions voyiez voyaient voyant vu vus vue
vues vis vit vîmes vîtes virent verrai verras verra verrons verrez verront verrais verrait
verrions verriez verraient voie voies
savoir sais sait savons savez savent savais savait savions saviez savaient sachant su sus sue
sues sut sûmes sûtes surent saurai sauras saura saurons saurez sauront saurais saurait
saurions sauriez sauraient sache saches sachions sachiez sachent sachez
pouvoir peux peut pouvons pouvez peuvent pouvais pouvait pouvions pouviez pouvaient pouvant
pu pus put pûmes pûtes purent pourrai pourras pourra pourrons pourrez pourront pourrais
pourrait pourrions pourriez pourraient puisse puisses puissions puissiez puissent
vouloir veux veut voulons voulez veulent voulais voulait voulions vouliez voulaient voulant
voulu voulus voulue voulues voulut voulûmes voulûtes voulurent voudrai voudras voudra
voudrons voudrez voudront voudrais voudrait voudrions voudriez voudraient veuille veuilles
veuillent veuillez
devoir dois doit devons devez doivent devais devait devions deviez devaient devant dû dus due
dues dut dûmes dûtes durent devrai devras devra devrons devrez devront devrais devrait
devrions devriez devraient doive doives
falloir faut fallait fallu faudra faudrait faille
valoir vaux vaut valons valez valent valais valait valions valiez valaient valant valu value
values vaudra vaudrai vaudrait vaille vaillent
pleuvoir pleut pleuvait pleuvant plu pleuvra pleuvrait pleuve
asseoir assieds assied asseyons asseyez asseyent assoit assoient assoyons assis assise
assises asseyant assiérai assoirai assoirait asseye
mourir meurs meurt mourons mourez meurent mourais mourait mourions mouriez mouraient mourant
mort morts morte mortes mourus mourut mourûmes mourûtes mourirent mourrai mourras mourra
mourrons mourrez mourront mourrais mourrait meure meures
naître nais naît naissons naissez naissent naissais naissait naissions naissiez naissaient
naissant né nés née nées naquis naquit naquîmes naquîtes naquirent naîtrai naîtras naîtra
naîtrons naîtrez naîtront naîtrais naîtrait naisse naisses
boire bois boit buvons buvez boivent buvais buvait buvions buviez buvaient buvant bu bus bue
bues but bûmes bûtes burent boirai boiras boira boirons boirez boiront boirais boirait boive
boives
croire crois croit croyons croyez croient croyais croyait croyions croyiez croyaient croyant
cru crus crue crues crut crûmes crûtes crurent croirai croiras croira croirons croirez
croiront croirais croirait croie croies
plaire plais plaît plaisons plaisez plaisent plaisais plaisait plaisions plaisiez plaisaient
plaisant plu plairai plaira plairait plaise plaisent
taire tais tait taisons taisez taisent taisais taisait taisant tu tue tues tut tairai taira
tairait taise
fuir fuis fuit fuyons fuyez fuient fuyais fuyait fuyions fuyiez fuyaient fuyant fui fuie fuies
fuirai fuira fuirait
haïr hais hait haïssons haïssez haïssent haïssais haïssait haïssant haï haïs haïe haïes haïrai
haïra haïrait haïsse
acquérir acquiers acquiert acquérons acquérez acquièrent acquérais acquérait acquérant acquis
acquise acquises acquerrai acquerra acquerrait acquière acquièrent
cueillir cueille cueilles cueillons cueillez cueillent cueillais cueillait cueillant cueilli
cueillie cueillies cueillerai cueillera cueillerait
vaincre vaincs vainc vainquons vainquez vainquent vainquais vainquait vainquant vaincu vaincue
vaincus vaincues vaincrai vaincra vaincrait vainque vainquent convaincre convaincs convainc
convainquons convainquent convaincu convaincue convaincus convaincra
coudre couds coud cousons cousez cousent cousais cousait cousant cousu cousue cousues coudrai
coudra coudrait couse
résoudre résous résout résolvons résolvez résolvent résolvais résolvait résolvant résolu
résolue résolues résoudrai résoudra résoudrait résolve
suffire suffis suffit suffisons suffisez suffisent suffisais suffisait suffisant suffi
suffirai suffira suffirait suffise
croître croîs croît croissons croissez croissent croissais croissait croissant crû croîtrai
croîtra croîtrait croisse
soustraire soustrais soustrait soustrayons soustrayez soustraient soustrayant soustraite
soustraites soustrairai soustraira soustrairait
`;

// =========================================================================
// Noms — pluriels produits par règle
// =========================================================================

export const NOUNS = `
abandon abonnement abord absence accent acceptation accès accident accord accueil achat acier
acte action activité addition adhésion adjoint administration admission adolescent adresse
adulte aéroport affaire affichage affiche âge agence agenda agent agrafe agrafeuse agriculture
aide air aise ajout alarme album alcool alerte alignement aliment allée allemand alliance
allocation allure alphabet amélioration amende ami amitié amour ampleur ampoule an analyse
ancêtre angle animal année annexe anniversaire annonce annuaire annulation antenne appareil
apparence appartement appel appellation appétit applaudissement application apport
apprentissage approche appui après-midi aptitude arbre arc architecte architecture archive
argent argument armée armoire arrangement arrestation arrêt arrivée article ascenseur aspect
assemblée assiette assistance assistant association assurance atelier attache attaque atteinte
attente attention attestation attitude attribut aube audience audit augmentation auteur
autobus automne automobile autonomie autorisation autorité autoroute avance avantage avenir
avenue aventure averse avertissement aveu avion avis avocat axe
bac bagage bague baie bain baisse bal balance balcon balle ballon banane banc bande banque
banquier bar barbe barrage barre barrière base bataille bateau bâtiment bâton batterie beauté
bébé besoin bêtise beurre bibliothèque bicyclette bien bière bijou bilan billet biologie
biscuit blague blanc blessure bloc blocage blog blouse bœuf boîte bol bon bonbon bonheur
bonjour bord bordereau bouche boucherie bouchon boucle boue bougie bouilloire boulangerie
boule boulevard boulot bourse bout bouteille boutique bouton branche bras brevet bricolage
brique brochure bronze brosse bruit brûlure budget buffet bug bulletin bureau but
cabine cabinet câble cadeau cadence cadre café cage cahier caisse calcul calendrier caméra
camion camp campagne canal canapé candidat candidature canne canton capacité capital capitale
caractère carafe carbone carnet carotte carré carreau carrefour carrière carte carton cas
casque cause cave ceinture célébration cellule cendre cent centaine centimètre centre cercle
céréale cerf cerise certificat certitude cerveau cessation chacal chaîne chair chaise chaleur
chambre champ champion chance changement chanson chant chantier chapeau chapitre charbon
charge chargement chariot charme charte chasse chat château chaud chauffage chauffeur chaussée
chaussette chaussure chef chemin cheminée chemise chèque cher cheval cheveu chèvre chien
chiffre chimie chocolat choix chômage chose chou chute cible ciel cigarette cinéma circuit
circulation cirque ciseau citation cité citoyen citron civilisation clair classe classement
classeur clause clavier clé client clientèle climat clinique cloche clocher clou club coche
code cœur coffre coiffeur coin col colère colis collaborateur collaboration collant collège
collègue collection collectivité colline collision colonne combat combinaison comédie
comité commande commentaire commerçant commerce commission communauté commune communication
compagne compagnie comparaison compartiment compétence compétition complément comportement
composant composition compréhension comptabilité comptable compte compteur comptoir
concentration concept conception concert concession concierge conclusion concours concurrence
concurrent condition conducteur conduite conférence confiance confidentialité configuration
confirmation conflit confort congé congrès conjoint connaissance connexion conquête
conscience conseil conseiller consentement conséquence conservation considération consigne
consommateur consommation constat constitution construction consultant consultation contact
contenu contexte continent contingent contour contrainte contrat contraste contribution
contrôle contrôleur convention conversation conviction copie coq coquille corbeille corde
corps correspondance correction cortège côte coteau côté cou couche coude couleur couloir
coup coupe cour courage courant courbe couronne courrier cours course court cousin coussin
coût couteau coutume couture couvercle couverture crainte crayon création créature crédit
crème créneau crise cristal critère critique croisement croissance croix croyance cru cuiller
cuillère cuir cuisine cuisinier cuisson culture curiosité cycle cylindre
danger danse date dauphin début décalage décembre déchet décision déclaration déclin décor
découpage découverte décret défaite défaut défense défi déficit définition degré délai
délégation délégué délit demande démarche déménagement demi démission démonstration dent
départ département dépassement dépense déplacement dépôt député dérivé dernier désaccord
descente description désert désir dessert dessin dessinateur destin destinataire destination
détail détective détention détermination dette deuil deux devanture développement devis devoir
diagnostic diagramme dialogue diamètre dictée dictionnaire différence difficulté diffusion
dimanche dimension diminution dîner diplôme direction directeur directive dirigeant discipline
discours discussion disparition disponibilité disposition dispositif dispute disque distance
distinction distraction distributeur distribution district divergence diversité division
dizaine docteur document documentation doigt domaine domicile dommage don donnée dos dossier
douane double douceur douche douleur doute douzaine drame drap drapeau droit droite durée
eau écart échange échantillon échéance échec échelle échéancier éclair éclairage école
économie écran écriture écrivain éditeur édition éducation effet efficacité effort égalité
église élan élection électricité électricien élément éléphant élève élévation éloge emballage
embauche embouteillage émission emploi employé employeur emprunt encadrement enchère
encre endroit énergie enfance enfant enjeu ennui enquête enregistrement enseignant
enseignement ensemble entente enthousiasme entier entité entourage entracte entraînement
entrée entreprise entretien enveloppe envie environnement envoi épaisseur épaule épicerie
époque épreuve équilibre équipe équipement équivalent erreur escalier espace espagnol espèce
espoir esprit essai essence essentiel estimation étable établissement étage étagère étape état
été étendue étiquette étoile étranger être étude étudiant euro évaluation événement évidence
évolution examen excédent exception excès exclusion excuse exécution exemplaire exemple
exercice exigence existence expédition expérience expert expertise explication exploitation
exploration explosion exportation exposé exposition expression extension extérieur extrait
fabricant fabrication fabrique face facilité façon facteur facture faculté faiblesse faim
faisceau fait famille fantaisie farine fatigue faute fauteuil faveur fax fédération félicitation
femme fenêtre fer ferme fermeture festival fête feu feuille feutre février ficelle fiche
fichier fidélité fierté figure fil file filet fille film fils filtre fin finance finition
firme fiscalité fixation flacon flamme flèche fleur fleuve flotte flux foi foire fois fonction
fonctionnaire fond fondation force forêt forfait formalité format formation forme formulaire
formule fortune forum fossé foule four fourchette fourniture fournisseur foyer fraction
frais franc français franchise frein fréquence frère friction frigo frisson froid fromage
front frontière fruit fuite fumée fusée fusion futur
gain galerie gamme gant garage garantie garçon garde gare gâteau gauche gaz géant gel
gendarme gêne général génération genou genre gens gentillesse géographie geste gestion
glace globe gloire golf gomme gorge goût goutte gouvernement grâce grade graine grammaire
gramme grand grandeur grange graphique gras gratitude gravité grève grille grippe gris gros
groupe guerre guichet guide guitare gymnase
habileté habitant habitation habitude haie haine haleine hall halte hameau hanche handicap
hangar harmonie hasard hausse haut hauteur hébergement hectare herbe héritage héros hésitation
heure heurt hier histoire hiver homme honneur honte hôpital horaire horizon horloge hôtel
huile huissier humeur humidité humour hypothèse
idée identification identité illustration image imagination immeuble immobilier impact
importance importation impôt impression imprimante imprimeur imprudence impulsion incendie
incident incitation inclusion inconvénient indemnité indépendance index indication indice
individu industrie infirmier inflation influence information informatique infraction
ingénieur initiale initiative injustice innovation inondation inquiétude inscription
insecte insistance inspection inspiration installation instant institut institution
instruction instrument insuffisance intégration intelligence intensité intention interdiction
intérêt intérieur intermédiaire interprétation interrogation interruption intervalle
intervention interview intitulé introduction intuition invasion inventaire investissement
invitation invité isolement issue itinéraire ivoire
jambe janvier jardin jargon jaune jet jeton jeu jeudi jeune jeunesse joie joint jonction
joue jouet jour journal journaliste journée joyau juge jugement juillet juin jumeau jument
jungle jupe jury jus justesse justice
kilo kilomètre kiosque
lac lacet lagune laine lait lame lampe lancement langage langue lapin laque largeur larme
laser lave lecteur lecture légende légume lendemain lenteur lettre levée lever levier lèvre
liaison libellé liberté librairie licence lien lieu lieutenant ligne limite lin linge liquide
liste lit litre livraison livre local locataire location logement logiciel logique loi loisir
long longueur lot loterie loup lourdeur loyer lumière lundi lune lunette lustre lutte luxe
lycée
machine mâchoire madame magasin magazine magie magistrat mai maillot main maintenance maire
mairie maison maître maîtrise majorité mal maladie malaise malchance malheur manche mandat
manière manifestation manœuvre manque manteau manuel maquette marbre marchand marchandise
marché marche mardi marge mari mariage marine marketing marque mars marteau masque masse
mât match matériel maternité mathématique matière matin matinée maturité maximum mécanicien
mécanisme méchanceté médaille médecin médecine média médicament meilleur mélange membre
mémoire menace ménage mensonge mention menu mer mercredi mère mérite message messagerie
mesure métal méthode métier mètre métro meuble meurtre midi miel milieu militaire mille
millier million mine minerai mineur minimum ministère ministre minorité minuit minute miroir
mise misère mission mode modalité modèle modem modération modification module moine mois
moitié moment monde monnaie monopole monsieur montagne montant monteur montre monument
morceau mort mot moteur motif moto mouche mouchoir mouvement moyen moyenne mur muraille
muscle musée musique mystère
nage naissance nappe narration nation nationalité nature navette navigateur navire nécessité
négligence négociation neige nerf nettoyage neveu nez niche nid niveau noce nœud noir noisette
noix nom nombre nomination nord normalisation norme note notice notion nourriture nouveau
nouveauté nouvelle novembre noyau nuage nuance nudité nuit numéro nylon
objectif objet obligation observation obstacle obtention occasion occupation océan octobre
odeur œil œuf œuvre offense office officier offre oignon oiseau ombre omission oncle ongle
opération opérateur opinion opposition option or orage orange orchestre ordinateur ordonnance
ordre oreille organe organisation organisme orgueil orientation origine ornement orthographe
os oubli ours outil ouverture ouvrage ouvrier oxygène
page paie paiement pain paix palais palier panier panne panneau pantalon papeterie papier
paquet paragraphe parapluie parc parcours pardon parent parenthèse paresse parfum pari parking
parlement parole part partage partenaire parti participant participation particularité partie
partenariat pas passage passager passé passeport passion pâte patience patient patron patte
pause pauvreté pavé pays paysage paysan peau péché pédale peine peintre peinture pellicule
pelouse pénalité pendule pénétration pensée pension pente perception perfection performance
péril période permanence permis permission personnage personne personnel perspective perte
peuple peur phase phénomène philosophie photo photographie phrase physique piano pièce pied
pierre piéton pile pilote pin pince pinceau pipe piquet piqûre piscine piste place placement
plafond plage plaine plainte plaisir plan planche plancher planning plante plaque plastique
plat plateau plein pli pluie plume pneu poche poêle poème poésie poids poignée point pointe
pointeur poire poison poisson poitrine poivre police politesse politique pollution pomme
pompe pont porc port portable porte portefeuille portière portion portrait pose position
possession possibilité poste pot poteau poubelle pouce poudre poulet poumon poupée pour
pourcentage poursuite poussière pouvoir pratique pré préavis précaution précédent précision
prédiction préférence préfet préjudice prélèvement prénom préoccupation préparation près
présence présentation présent président presse pression prestation prêt prétention preuve
prévision prière primaire prime principe printemps priorité prise prison prix probabilité
problème procédé procédure procès processus prochain proclamation production produit
professeur profession profil profit profondeur programme progrès projecteur projet
prolongement promenade promesse promotion pronom proportion proposition propreté propriétaire
propriété prospection protection protestation prototype provenance province provision
proximité prudence prune public publication publicité puissance puits pull punition pupitre
qualification qualité quantité quart quartier question queue quittance quotidien
race racine radar radiateur radio rail raison ralentissement rambarde rame ramette rampe
rang rangée rappel rapport rapprochement rareté rasoir rassemblement rate ratio rature ravin
rayon rayonnage réaction réalisation réalité rébellion recette receveur réception recette
recherche récipient réclamation recommandation récompense reconnaissance record recours
recrutement rectangle recu recueil recul récupération rédacteur rédaction réduction
réel référence reflet réflexion réforme refus regard régime région registre règle règlement
regret rein reine rejet relation relevé relief religion remarque remboursement remède remise
remplacement rencontre rendement rendez-vous renfort renouvellement renseignement rente
rentrée réparation repas répertoire répétition réplique réponse report repos reprise
reproduction république réputation requête réseau réservation réserve résidence résistance
résolution résultat résumé retard retenue retour retrait retraite réunion réussite revanche
rêve réveil revenu revers révision revue rez-de-chaussée rideau ride rien rigueur rime
ring risque rivage rive rivière riz robe robinet roche rocher roi rôle roman rond rondelle
rose rotation roue rouge rouille rouleau route routine ruban rubrique rue ruine ruisseau
rumeur rupture rythme
sable sac sacrifice sagesse saison salaire salarié salle salon salut samedi sanction sang
santé satisfaction saucisse saut sauvegarde savant saveur savoir savon scandale scène schéma
science scie scission score scrutin séance seau sécheresse second secondaire seconde secours
secret secrétaire secrétariat secteur section sécurité séjour sel sélection semaine semelle
semence séminaire sens sensation sensibilité sentiment séparation septembre série sérieux
serpent serrure serveur service serviette session seuil sévérité sexe siège sigle signal
signalement signataire signature signe signification silence sillon similitude simplicité
singe site situation ski slogan société soie soif soin soir soirée sol soldat solde soleil
solidarité solidité solution sommaire somme sommeil sommet son sondage sonnerie sorte sortie
souci soude souffle souffrance souhait soulagement soulèvement soupçon soupe source sourcil
sourire souris sous-sol soutien souvenir spécialiste spécialité spectacle spectateur sphère
sport stade stage stagiaire standard station statistique statue statut stock stratégie
structure studio style stylo substance succès succursale sucre sud suggestion suite sujet
supérieur supermarché supplément support suppression surface surprise surveillance survie
suspension syllabe symbole sympathie symptôme syndicat synthèse système
table tableau tablette tabouret tache tâche taille talent talon tambour tampon tante taon
tapis tarif tas tasse taux taxe taxi technicien technique technologie teinte télécopie
télégramme téléphone télévision témoignage témoin température tempête temps tendance tenue
terme terminal terrain terrasse terre territoire tête texte textile thé théâtre thème
théorie thèse ticket tiers tige timbre timidité tirage tiret tiroir tissu titre toile toilette
toit tôle tolérance tomate tombe ton tonalité tonne tonneau torchon tort total touche
tour tourisme tournant tournée tournevis tournoi tousse tout toux trace tracé tract tradition
traduction trafic train trait traité traitement trajet tramway tranche transaction transfert
transformation transition transmission transport travail travailleur travers traversée
trésor tri tribunal tribut tricot trimestre triomphe tristesse troc trois trombone trompette
tronc trop trottoir trou troupe trousse truc tube tuile tunnel turbine tuyau type
unanimité union unité univers université urgence usage usager usine ustensile usure utilité
utilisateur utilisation
vacances vaccin vache vague vaisseau vaisselle valeur valise vallée valorisation vapeur
variante variation variété vase vaste veille veine vélo velours vendeur vendredi vengeance
vente ventilateur vent ventre verdict vérification vérité verre verrou vers version vert
vertu veste vêtement veuve viande victime victoire vide vidéo vie vieillesse vierge vigne
vigueur village ville vin vinaigre vingtaine violence violon virage virement virgule vis
visa visage viseur visibilité vision visite visiteur vitamine vitesse vitre vitrine vivacité
vocabulaire vœu voie voile voisin voisinage voiture voix vol volaille volant volet volonté
volume vote voyage voyageur voyelle vue
wagon week-end
zèbre zèle zone zoo

abonné acquéreur adhérent affichage agrément alignement altération amorce anneau annulation
anomalie apercu aperçu aplat appairage arborescence archivage arrondi assemblage
bandeau bannière bascule bordure borne bulle
cadenas calque canevas caractéristique cartouche catalogue cellier chargement chiffrement
cible clé cloison codage collaborateur collaboration commutation compression concordance
conformité connecteur consolidation contour conversion corrélation coupure courbure
créneau croissant croquis cumul cursor curseur
dégradé déchiffrement déclencheur décodage décompression décoration décrochage dédoublonnage
déploiement dérive désactivation destinataire diapositive diapo diffusion dimensionnement
disposition dossier doublon
échantillonnage échéancier éclair écrasement écriteau élan ellipse empilement empreinte
encadré encart enchaînement encodage en-tête entête épaisseur étoile exhaustivité exportation
extraction extrémité
facturation filigrane finalisation flèche fluidité fonctionnalité formalisme fusion
géométrie gestionnaire glissement grille groupement
habillage hachure hauteur hexagone horodatage
identifiant illisibilité importation impression indentation index indexation infobulle
insertion intégrité interlettrage interligne intitulé
jalon jointure justification
lettrine libellé lien lisibilité losange
majuscule marqueur métadonnée minuscule modèle mosaïque
niveau normalisation numérisation numérotation
occurrence octogone ombre opacité organigramme orientation ossature
paginateur pagination panorama parité passerelle pastille pentagone périmètre pictogramme
piste placeholder poignée pointillé polygone préréglage présentateur profilage prototypage
puce
quadrillage
recadrage recouvrement rectangle redimensionnement redressement référencement remplissage
renvoi répertoire repli restauration retouche rétroplanning révocation rognage rotation
saisie sceau schéma sélecteur sélection semis séparateur seuillage signature soulignement
sous-titre spécification survol synchronisation synoptique
tabulation taquet teinte teneur tesselle tiret trame transposition trapèze tri tuile
validation valorisation vecteur verrouillage vignette visualisation

ajustement ancrage annotation authentification cryptographie démarrage dépendance détection
effacement espacement explorateur fantôme installateur migration miniature molette paire
parité planification primitive publipostage regroupement renommage reconstruction réécriture
ressource robustesse rupture scalaire surlignage typographie vulnérabilité
administrateur configurateur correcteur créateur détenteur mainteneur relais
catégorie cohérence certification déverrouillage finalité lacune portabilité rectification
répudiation télémétrie condensé manuscrit maître maîtresse
`;

// =========================================================================
// Adjectifs — féminins et pluriels produits par règle
// =========================================================================

export const ADJ = `
abondant absent absolu abstrait absurde acceptable accessible actif actuel adapté adéquat
administratif admirable adroit affreux âgé agréable agressif agricole aigu aimable ainé
alimentaire allemand ambigu ambitieux amer américain amical ample ancien anglais animé annuel
anonyme antérieur anxieux apparent appliqué approprié apte arbitraire ardent argenté aride
artificiel artisanal artistique assis assuré attentif attractif audacieux authentique
automatique autonome autre auxiliaire avantageux aveugle avide
banal bancaire bas beau bénéfique bête bienveillant bizarre blanc bleu bon brave bref brillant
britannique brun brut bruyant
calme capable capital caractéristique cardinal carré catégorique célèbre central certain
chaleureux chaud chef cher chimique chinois chrétien civil clair classique clé clos collectif
coloré comique commercial commode commun compact comparable compatible compétent complet
complexe compliqué composé compris concis concret concurrent confidentiel confortable conforme
connu conscient conséquent considérable constant constructif contemporain content continu
contradictoire contraire convenable convaincant coopératif correct correspondant coupable
courageux courant court coûteux couvert créatif crédible creux criminel critique cru cruel
culturel curieux
dangereux décevant décisif défavorable définitif délicat démocratique dense dernier désagréable
descriptif désert désireux désolé destiné détaillé déterminé difficile digital digne diligent
direct discret disponible distant distinct distingué divers divin documentaire domestique
dominant doré double doux douteux droit drôle dur durable dynamique
écologique économique effectif efficace égal élégant élémentaire élevé éloigné embarrassé
émotif empirique énergique énorme ensoleillé entier entraînant environnemental
épais équitable équivalent errant essentiel esthétique étonnant étrange étranger étroit
européen éventuel évident exact excellent exceptionnel excessif exclusif exigeant existant
expérimental explicite express extérieur externe extraordinaire extrême
fabuleux facile facultatif faible fameux familial familier fantastique fascinant fatal fatigué
faux favorable fédéral féminin fermé fertile fidèle fier fin final financier fiscal fixe
flexible flou fondamental fondé fort fou fragile frais français franc fréquent frileux froid
frontal fructueux fumé futur
gai général généreux génial gentil géographique glacé global glorieux gracieux graduel
grammatical grand grave grec gris gros grossier
habile habituel haut hebdomadaire heureux historique honnête honorable horizontal horrible
hostile huileux humain humble humide
idéal identique idiot ignorant illégal illimité illisible illustre imaginaire immédiat immense
immobile important impossible imprécis impressionnant improbable inacceptable inattendu
incapable incertain incomplet inconnu incorrect indépendant indirect indispensable individuel
industriel inefficace inégal inévitable inexact inférieur infini influent informatique
initial injuste innocent inoffensif inquiet insensible insignifiant insolite instable
insuffisant intact intégral intelligent intense intentionnel interactif intéressant intérieur
intermédiaire international interne intime introuvable inutile inverse invisible irrégulier
isolé italien
jaloux japonais jaune joli jeune joyeux judiciaire juridique juste
lâche laid laïque large latéral latin léger légal légendaire légitime lent lettré libéral libre
lié limité linéaire liquide lisible lisse littéraire local logique long lourd loyal lucide
lumineux
magique magnifique maigre majeur malade maladroit malheureux manuel marginal marin maritime
marron masculin massif matériel maternel mauvais mécanique méchant médical médiéval meilleur
mélangé même mensuel mental menteur mesuré métallique méthodique méticuleux mignon militaire
mince mineur minimal ministériel mixte mobile modéré moderne modeste moindre mondial monotone
moral mort mou mouillé moyen multiple municipal mûr musical mutuel mystérieux
national naturel nécessaire négatif négligeable neuf neutre noble noir nombreux normal
notable notoire nouveau nucléaire nul numérique
obligatoire obscur observateur obtenu occasionnel occidental occupé océanique odieux officiel
officieux ombragé opaque opérationnel opposé optimal optimiste ordinaire organique original
ouvert
paisible pâle parallèle parfait parfumé parlementaire particulier partiel passager passif
patient pauvre payant pédagogique peint pénible pensif perdu performant périodique permanent
perpendiculaire personnel pertinent pesant petit peuplé physique pittoresque plat plein 
poétique poli politique polluant ponctuel populaire portable positif possible postal potentiel
pratique précédent précieux précis préférable préliminaire premier prêt prévu primaire
principal privé probable productif professionnel profitable profond progressif propice propre
prospère protecteur provincial provisoire proche public puissant pur
qualifié quotidien
radical raide raisonnable rapide rare rassurant rationnel réactif réaliste récent réciproque
reconnu rectangulaire redoutable réel régional régulier relatif religieux remarquable rentable
répandu répétitif représentatif requis réservé résistant respectueux responsable ressemblant
restreint retardé rétréci réussi révolutionnaire riche ridicule rigide rigoureux risqué rival
robuste romain rond rose rouge routinier roux royal rural rusé russe
sacré sage saillant sain saisonnier salé sale satisfaisant sauvage savant scientifique
scolaire second secondaire secret sectoriel sec sélectif semblable sensationnel sensible
sentimental séparé sérieux serré seul sévère significatif silencieux similaire simple sincère
singulier social soigné solaire solide solitaire sombre sommaire sonore souple sourd
soutenu spatial spécial spécifique spectaculaire spirituel splendide spontané sportif stable
standard statistique stérile strict structurel studieux subjectif substantiel subtil succinct
successif suffisant suisse suivant supérieur supplémentaire sûr surprenant suspect
symbolique sympathique syndical systématique
tacite tactique tardif technique tel temporaire tendre tendu tenu terne terrestre terrible
territorial théorique tiède timide tolérant total touchant touristique tout traditionnel
tranquille transparent triste triple troublé typique
ultérieur unanime unique universel urbain urgent usé usuel utile
vacant vague vain valable valide vaniteux varié vaste végétal véhément verbal véritable vert
vertical vertueux vide vieux vif vigilant violent violet virtuel visible visuel vital vivant
volontaire volumineux vrai vulnérable

adossé ajustable alphanumérique ambidextre annexe arrondi asymétrique binaire bureautique
canonique chiffré cliquable collaboratif compatible conforme contigu croisé cryptographique
décalé dégradé délimité désactivé détaillé duplicable éditable embarqué encadré épuré
équidistant exhaustif expansible extensible figé filigrané fléché granulaire hachuré
hiérarchique homogène horodaté imbriqué immuable importable imprimable inaltérable
incrémental indexé inférieur interopérable irréversible itératif juxtaposé
lisible manquant modulable monospace multilingue multiniveau numérique optionnel orthogonal
paramétrable partagé périmé pixelisé prédéfini préréglé quadrillé récursif redimensionnable
répertorié réversible sécurisé sélectionnable soulignable structuré supprimable surlignable
symétrique tabulaire typographique verrouillé versionné
accidentel aléatoire alphabétique conditionnel identifiant impair pair primitif solidaire
unitaire éprouvé statique
persistant idempotent additif transitoire mutable superficiel destructif déclaratif scopé
`;

// =========================================================================
// Invariables : adverbes, prépositions, conjonctions, pronoms, déterminants
// =========================================================================

export const INVAR = `
à afin ailleurs ainsi alors après assez au aucun aucune aujourd'hui auparavant auprès auquel
aussi aussitôt autant autour autrefois autrement aux auxquelles auxquels avant avec beaucoup
bien bientôt car ce ceci cela celle celles celui cependant certes ces cet cette ceux chacun
chacune chaque chez ci combien comme comment contre dans davantage de dedans dehors déjà
delà demain depuis derrière des dès désormais desquels dessous dessus deux dix dont donc douze
du dû duquel durant elle elles en encore enfin ensemble ensuite entre envers environ et
étant eux exprès face fois fort guère hier hors ici il ils jamais je jusque jusqu la là
laquelle le lequel les lesquelles lesquels leur leurs loin longtemps lors lorsque lui ma
maintenant mais mal malgré me même mes mien mieux moi moins mon même ne néanmoins ni non nos
notamment notre nôtre nous nul nulle on ont onze ou où oui outre par parce parfois parmi
partout pas pendant peu peut-être plus plusieurs plutôt pour pourquoi pourtant près presque
puis puisque quand quant quatorze quatre que quel quelle quelquefois quelles quelque quelques
quelqu'un quels qui quiconque quinze quoi quoique rien sa sans sauf se seize selon sept ses
si sien sinon six soi soit son sons sont sous souvent surtout sur ta tandis tant tard te tel
telle telles tels tes tien toi ton toujours tous tout toute toutes très treize trente trois
trop tu un une vers via vingt vite voici voilà volontiers vos votre vôtre vous vraiment y
zéro
bref cependant certainement d'abord d'accord d'ailleurs davantage effectivement également
évidemment finalement globalement heureusement immédiatement également notamment naturellement
néanmoins normalement parfaitement particulièrement peut-être précisément principalement
probablement quasiment récemment relativement seulement simplement souvent spécialement
suffisamment sûrement toutefois uniquement vraisemblablement
etc cf ibid idem versus via
merci bonjour bonsoir salut adieu bravo hélas ok voilà tant pis
`;

/**
 * Noms propres et abréviations d'usage.
 *
 * Les mots capitalisés sont de toute façon ignorés par la règle des noms propres,
 * mais un pays ou un mois écrit en minuscules dans une énumération doit rester
 * reconnu — et « M. », « Mme », « etc. » sont partout.
 */
export const PROPER = `
janvier février mars avril mai juin juillet août septembre octobre novembre décembre
lundi mardi mercredi jeudi vendredi samedi dimanche
France Paris Lyon Marseille Toulouse Nice Nantes Strasbourg Montpellier Bordeaux Lille Rennes
Reims Toulon Grenoble Dijon Angers Nîmes Villeurbanne Metz Rouen Tours Amiens Limoges Brest
Perpignan Besançon Orléans Mulhouse Caen Nancy Avignon Poitiers Belgique Bruxelles Suisse
Genève Lausanne Zurich Berne Luxembourg Québec Montréal Ottawa Canada Allemagne Berlin Munich
Espagne Madrid Barcelone Italie Rome Milan Portugal Lisbonne Angleterre Londres Royaume-Uni
Irlande Dublin Écosse Pays-Bas Amsterdam Danemark Copenhague Suède Stockholm Norvège Oslo
Finlande Helsinki Pologne Varsovie Autriche Vienne Grèce Athènes Turquie Istanbul Maroc Rabat
Casablanca Algérie Alger Tunisie Tunis Sénégal Dakar Côte-d'Ivoire Abidjan Cameroun Mali
Bamako Congo Kinshasa Madagascar Haïti Liban Beyrouth Égypte Caire Israël Jérusalem
États-Unis Washington New-York Chicago Boston Californie Texas Floride Mexique Brésil Brasilia
Argentine Chili Colombie Pérou Chine Pékin Shanghai Japon Tokyo Corée Séoul Inde Delhi
Australie Sydney Nouvelle-Zélande Russie Moscou Ukraine Kiev Roumanie Bucarest Hongrie Budapest
Europe Afrique Asie Amérique Océanie Atlantique Méditerranée Pacifique Alpes Pyrénées Loire
Seine Rhône Garonne Rhin
Elium Word Excel PowerPoint Windows Linux macOS Android Google Microsoft Apple Adobe
français française allemand anglais espagnol italien portugais néerlandais suédois russe
chinois japonais arabe européen américain africain asiatique
M Mme Mlle MM Dr Pr St Ste Me
`;

/**
 * Mots invariables techniques, sigles et emprunts courants.
 *
 * Le vocabulaire informatique et de gestion arrive dans les documents beaucoup plus
 * vite que dans les dictionnaires : sans lui, un compte rendu de réunion serait
 * souligné de bout en bout.
 */
export const TECH = `
antivirus applicatif backup bit blog bogue bug byte cache captcha chat clic cloud code
connecteur cookie curseur cyberattaque cybersécurité datacenter débogage design développeur
disque données driver e-mail écran email émoji en-tête entrepôt fichier firewall flux forum
framework hacker hameçonnage hébergeur hyperlien identifiant informaticien infrastructure
intranet interface internet lien logiciel login logo mail malware matériel mégaoctet mél
menu message messagerie microprocesseur mot-clé multimédia navigateur newsletter numérisation
octet onglet ordinateur pare-feu pdf périphérique pixel podcast portail processeur progiciel
protocole raccourci rançongiciel réseau routeur sauvegarde scanner serveur signet site
smartphone spam streaming tableur tablette téléchargement téléconférence télétravail
terminal tutoriel URL utilisateur virus visioconférence web webinaire wifi
audit budget cadrage chiffrage cotation devis échéance facturation faisabilité gouvernance
jalon livrable pilotage prestataire prévisionnel prospect reporting rétroplanning
sous-traitance tableur trésorerie
`;
