/**
 * Référentiel d'activités du BTS Gestion de la PME : 4 domaines, 22 activités, 102 tâches.
 * Généré à partir du classeur officiel « BTS_GPME_PasseportPro » (feuille « Passeport professionnel »).
 * Les 6 activités du domaine 1 sont celles de l'épreuve E4 ; le domaine 2 relève de la sous-épreuve E51.
 */
import type { RefDomain } from "./types";

export const REFERENTIEL: RefDomain[] = [
  {
    id: "1",
    title: "GÉRER LA RELATION AVEC LES CLIENTS ET LES FOURNISSEURS DE LA PME",
    activities: [
      {
        id: "1.1",
        title: "Recherche de clientèle et contact",
        competence: "Rechercher des clients par prospection ou pour répondre à un appel d’offres",
        tasks: [
          {
            id: "1.1.1",
            label: "Organisation de la prospection et prospection clientèle",
          },
          {
            id: "1.1.2",
            label: "Détection, analyse et suivi des appels d’offres",
          },
          {
            id: "1.1.3",
            label:
              "Communication avec des acteurs internes, avec les prospects, les clients et les pouvoirs adjudicateurs",
          },
        ],
      },
      {
        id: "1.2",
        title: "Administration des ventes de la PME",
        competence: "Traiter la demande du client (de la demande de devis jusqu’à la relance des éventuels impayés)",
        tasks: [
          {
            id: "1.2.1",
            label: "Préparation de propositions commerciales",
          },
          {
            id: "1.2.2",
            label:
              "Préparation des contrats commerciaux (commandes, contrats de maintenance, garanties complémentaires, contrats de sous-traitance, etc.)",
          },
          {
            id: "1.2.3",
            label: "Suivi des ventes et des livraisons",
          },
          {
            id: "1.2.4",
            label: "Facturation,  suivi des règlements et des relances « clients »",
          },
          {
            id: "1.2.5",
            label: "Évaluation du risque client",
          },
          {
            id: "1.2.6",
            label: "Mise à jour du système d’information « clients »",
          },
          {
            id: "1.2.7",
            label: "Communication avec des acteurs internes, les fournisseurs et les clients",
          },
        ],
      },
      {
        id: "1.3",
        title: "Maintien et développement de la relation avec les clients de la PME",
        competence: "Informer, conseiller, orienter et traiter les réclamations",
        tasks: [
          {
            id: "1.3.1",
            label: "Accueil, information et conseils",
          },
          {
            id: "1.3.2",
            label: "Traitement et suivi des réclamations",
          },
          {
            id: "1.3.3",
            label: "Communication pour développer la relation client",
          },
        ],
      },
      {
        id: "1.4",
        title: "Recherche et choix des fournisseurs de la PME",
        competence: "Rechercher et sélectionner les fournisseurs",
        tasks: [
          {
            id: "1.4.1",
            label: "Étude des projets d’achats et des investissements",
          },
          {
            id: "1.4.2",
            label: "Recherche des fournisseurs",
          },
          {
            id: "1.4.3",
            label: "Comparaison des offres, sélection et qualification des fournisseurs",
          },
          {
            id: "1.4.4",
            label: "Mise à jour du système d’information fournisseurs",
          },
          {
            id: "1.4.5",
            label: "Communication avec des acteurs internes et avec les fournisseurs",
          },
        ],
      },
      {
        id: "1.5",
        title: "Suivi et contrôle des opérations d’achats et d’investissement de la PME",
        competence:
          "Passer les commandes d’achat et d’immobilisation et les contrôler, valider le règlement, évaluer les fournisseurs.",
        tasks: [
          {
            id: "1.5.1",
            label: "Préparation de la négociation des contrats",
          },
          {
            id: "1.5.2",
            label: "Passation et suivi des commandes",
          },
          {
            id: "1.5.3",
            label: "Acquisition et suivi des immobilisations",
          },
          {
            id: "1.5.4",
            label: "Contrôle des achats et des règlements",
          },
          {
            id: "1.5.5",
            label: "Évaluation des fournisseurs",
          },
          {
            id: "1.5.6",
            label:
              "Communication écrite et orale avec des acteurs internes, les fournisseurs et les partenaires financiers",
          },
        ],
      },
      {
        id: "1.6",
        title: "Suivi comptable des opérations avec les clients et les fournisseurs de la PME",
        competence: "Assurer le suivi comptable des opérations commerciales",
        tasks: [
          {
            id: "1.6.1",
            label: "Contrôle de l’enregistrement comptable des opérations d’achats, de ventes et de règlements",
          },
          {
            id: "1.6.2",
            label: "Suivi des relations avec les banques",
          },
          {
            id: "1.6.3",
            label: "Suivi de la trésorerie des comptes de tiers, des encaissements et des décaissements",
          },
          {
            id: "1.6.4",
            label: "Préparation et contrôle de la déclaration de TVA",
          },
          {
            id: "1.6.5",
            label: "Évaluation et suivi des risques liés aux échanges internationaux",
          },
        ],
      },
    ],
  },
  {
    id: "2",
    title: "PARTICIPER À LA GESTION DES RISQUES DE LA PME",
    activities: [
      {
        id: "2.1",
        title: "Conduite d’une veille",
        competence: "Conduire une veille",
        tasks: [
          {
            id: "2.1.1",
            label: "Mise en place d’une veille",
          },
          {
            id: "2.1.2",
            label: "Qualification de l’information",
          },
          {
            id: "2.1.3",
            label: "Mise en évidence de risques éventuels",
          },
          {
            id: "2.1.4",
            label: "Alerte des responsables de la PME",
          },
          {
            id: "2.1.5",
            label: "Synthèse et diffusion de l’information",
          },
          {
            id: "2.1.6",
            label: "Mise à jour des pratiques et des procédures",
          },
        ],
      },
      {
        id: "2.2",
        title: "Participation à la mise en place d’un travail en mode projet au sein de la PME",
        competence: "Accompagner la mise en place d’un travail en mode « projet »",
        tasks: [
          {
            id: "2.2.1",
            label: "Identification du besoin en termes d’organisation",
          },
          {
            id: "2.2.2",
            label: "Conduite d’une analyse fonctionnelle interne et externe",
          },
          {
            id: "2.2.3",
            label: "Élaboration du cahier des charges et planification des tâches à réaliser",
          },
          {
            id: "2.2.4",
            label: "Organisation et conduite de réunions avec les acteurs du projet",
          },
          {
            id: "2.2.5",
            label: "Suivi du projet",
          },
        ],
      },
      {
        id: "2.3",
        title: "Mise en œuvre d’une démarche de gestion des risques de la PME",
        competence: "Identifier, évaluer les risques de l’entreprise et proposer des actions correctrices.",
        tasks: [
          {
            id: "2.3.1",
            label: "Identification des risques",
          },
          {
            id: "2.3.2",
            label: "Conduite d’une veille relative à la réglementation et à la certification",
          },
          {
            id: "2.3.3",
            label: "Identification des obligations légales",
          },
          {
            id: "2.3.4",
            label: "Analyse, évaluation des risques et alertes éventuelles des dirigeants de la PME",
          },
          {
            id: "2.3.5",
            label: "Proposition d'actions correctrices",
          },
          {
            id: "2.3.6",
            label: "Mise en œuvre, diffusion et suivi des actions validées",
          },
        ],
      },
      {
        id: "2.4",
        title: "Participation à la gestion des risques financiers de la PME",
        competence: "Évaluer et suivre les risques financiers de la PME en termes de trésorerie",
        tasks: [
          {
            id: "2.4.1",
            label: "Identification des échéances à court et moyen terme",
          },
          {
            id: "2.4.2",
            label: "Suivi des flux de trésorerie",
          },
          {
            id: "2.4.3",
            label: "Évaluation des risques financiers à court et moyen terme",
          },
          {
            id: "2.4.4",
            label: "Alerte des responsables de la PME",
          },
          {
            id: "2.4.5",
            label: "Proposition de solutions",
          },
          {
            id: "2.4.6",
            label: "Mise en œuvre et suivi des actions validées",
          },
        ],
      },
      {
        id: "2.5",
        title: "Participation à la gestion des risques non financiers de la PME",
        competence: "Gérer des risques identifiés dans la PME",
        tasks: [
          {
            id: "2.5.1",
            label: "Gestion des risques liés à la santé, à l'hygiène et à la sécurité au travail",
          },
          {
            id: "2.5.2",
            label: "Gestion des risques liés à la protection des personnes, des biens et des droits",
          },
          {
            id: "2.5.3",
            label: "Gestion des risques environnementaux",
          },
          {
            id: "2.5.4",
            label: "Gestion des risques informatiques et des risques liés aux données",
          },
        ],
      },
      {
        id: "2.6",
        title: "Mise en place d’une démarche qualité au sein de la PME",
        competence: "Mettre en place une démarche qualité au sein de la PME",
        tasks: [
          {
            id: "2.6.1",
            label: "Analyse de l’existant",
          },
          {
            id: "2.6.2",
            label: "Formalisation, diffusion, contrôle et amélioration des procédures",
          },
          {
            id: "2.6.3",
            label: "Participation à la mise en place de procédures de gestion des connaissances",
          },
          {
            id: "2.6.4",
            label: "Veille sur la certification",
          },
          {
            id: "2.6.5",
            label: "Mise en œuvre et suivi de la démarche de certification",
          },
        ],
      },
    ],
  },
  {
    id: "3",
    title: "GÉRER LE PERSONNEL ET CONTRIBUER À LA GESTION DES RESSOURCES HUMAINES de LA PME",
    activities: [
      {
        id: "3.1",
        title: "Gestion administrative du personnel de la PME",
        competence:
          "Assurer le suivi administratif du personnel\nPréparer les éléments de la paie et communiquer sur ces éléments \nOrganiser les élections des représentants du personnel",
        tasks: [
          {
            id: "3.1.1",
            label: "Suivi des formalités et procédures d’embauche et de départ",
          },
          {
            id: "3.1.2",
            label: "Organisation et suivi des dossiers du personnel",
          },
          {
            id: "3.1.3",
            label: "Gestion du temps de travail, des absences et des congés",
          },
          {
            id: "3.1.4",
            label: "Préparation et contrôle des éléments de la paie",
          },
          {
            id: "3.1.5",
            label: "Réalisation des déclarations sociales",
          },
          {
            id: "3.1.6",
            label:
              "Mise en place des modalités de représentation du personnel et de négociation au sein de l’entreprise",
          },
          {
            id: "3.1.7",
            label:
              "Communication avec la direction, les salariés, les instances représentatives du personnel de la PME, les spécialistes de gestion du personnel et l’administration",
          },
        ],
      },
      {
        id: "3.2",
        title: "Participation à la gestion des ressources humaines de la PME",
        competence: "Participer à la gestion des ressources humaines",
        tasks: [
          {
            id: "3.2.1",
            label: "Aide au recrutement",
          },
          {
            id: "3.2.2",
            label: "Intégration des nouveaux membres",
          },
          {
            id: "3.2.3",
            label: "Préparation et suivi des actions de formation",
          },
          {
            id: "3.2.4",
            label: "Préparation et mise en place de l'évaluation des personnels",
          },
          {
            id: "3.2.5",
            label: "Préparation et suivi de tableaux de bord sociaux",
          },
          {
            id: "3.2.6",
            label:
              "Communication avec la direction et les salariés de la PME, les organismes de formation, les organismes paritaires collecteurs, les prestataires externes du recrutement",
          },
        ],
      },
      {
        id: "3.3",
        title: "Contribution à la cohésion interne de la PME",
        competence: "Contribuer à la cohésion interne du personnel de l'entreprise",
        tasks: [
          {
            id: "3.3.1",
            label: "Contribution à la qualité des relations interpersonnelles",
          },
          {
            id: "3.3.2",
            label: "Contribution à la mise en place d’un travail collaboratif",
          },
        ],
      },
    ],
  },
  {
    id: "4",
    title: "SOUTENIR LE FONCTIONNEMENT ET LE DÉVELOPPEMENT DE LA PME",
    activities: [
      {
        id: "4.1",
        title: "Contribution à la qualité du système d’information de la PME",
        competence: "Représenter, analyser, améliorer le système d’information de la PME",
        tasks: [
          {
            id: "4.1.1",
            label: "Caractérisation du système d’information",
          },
          {
            id: "4.1.2",
            label: "Évaluation des besoins d’information",
          },
          {
            id: "4.1.3",
            label: "Collecte et contrôle des informations",
          },
          {
            id: "4.1.4",
            label: "Structuration des informations et des flux d’information",
          },
          {
            id: "4.1.5",
            label: "Classement et archivage des documents",
          },
          {
            id: "4.1.6",
            label: "Participation à l’évolution du système d’information",
          },
        ],
      },
      {
        id: "4.2",
        title: "Organisation des activités de la PME",
        competence: "Améliorer des processus « support » et organiser et suivre les activités de la PME",
        tasks: [
          {
            id: "4.2.1",
            label: "Contribution à l’évolution des processus « supports »",
          },
          {
            id: "4.2.2",
            label: "Amélioration et suivi de l’organisation du travail administratif",
          },
          {
            id: "4.2.3",
            label: "Planification des activités et des prestations (chantiers, interventions, etc.)",
          },
          {
            id: "4.2.4",
            label: "Organisation des déplacements",
          },
          {
            id: "4.2.5",
            label: "Organisation d’événements internes,  participation à des événements externes",
          },
          {
            id: "4.2.6",
            label: "Communication avec des acteurs internes et des prestataires pour organiser les activités de la PME",
          },
        ],
      },
      {
        id: "4.3",
        title: "Participation au développement commercial national ou international de la PME",
        competence: "Participer au développement commercial de la PME et à la fidélisation de la clientèle",
        tasks: [
          {
            id: "4.3.1",
            label: "Veille commerciale et suivi de l’évolution du marché de l’entreprise",
          },
          {
            id: "4.3.2",
            label: "Analyse des tendances du marché",
          },
          {
            id: "4.3.3",
            label: "Fidélisation de la clientèle",
          },
        ],
      },
      {
        id: "4.4",
        title: "Contribution à la mise en œuvre de la communication de la PME",
        competence: "Accompagner le déploiement du plan de communication de la PME",
        tasks: [
          {
            id: "4.4.1",
            label: "Contribution à la communication institutionnelle",
          },
          {
            id: "4.4.2",
            label: "Contribution à la communication commerciale",
          },
          {
            id: "4.4.3",
            label: "Suivi de l’identité numérique",
          },
          {
            id: "4.4.4",
            label: "Contrôle du respect de l’image dans les actions de communication",
          },
        ],
      },
      {
        id: "4.5",
        title: "Participation à l’analyse de l’activité de la PME",
        competence: "Analyser l’activité de la PME",
        tasks: [
          {
            id: "4.5.1",
            label: "Calcul et analyse des coûts et des résultats",
          },
          {
            id: "4.5.2",
            label: "Réalisation des budgets prévisionnels",
          },
          {
            id: "4.5.3",
            label: "Mesure de l'impact de décisions de gestion sur les coûts et les résultats",
          },
        ],
      },
      {
        id: "4.6",
        title: "Participation au diagnostic financier de la PME",
        competence: "Produire et analyser des informations de nature financière",
        tasks: [
          {
            id: "4.6.1",
            label: "Analyse financière",
          },
          {
            id: "4.6.2",
            label: "Mesure de l’impact de décisions de gestion sur les équilibres financiers",
          },
        ],
      },
      {
        id: "4.7",
        title: "Participation à l’élaboration de tableaux de bord de la PME",
        competence:
          "Identifier les facteurs explicatifs de la performance commerciale et financière, concevoir et analyser un tableau de bord",
        tasks: [
          {
            id: "4.7.1",
            label: "Conception et suivi des indicateurs pertinents de gestion et d’alerte",
          },
          {
            id: "4.7.2",
            label: "Établissement d’un tableau de bord dans ses dimensions commerciales et financières",
          },
        ],
      },
    ],
  },
];
