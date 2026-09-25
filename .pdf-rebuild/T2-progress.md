# T2 — Formulaires — journal de reprise

## État
- 2026-09-25 : démarrage (aucune tentative précédente). Lecture PLAN, README, diag forms.

## Fait
- Étape 1 (commit f3ef868) : core/forms/values.ts (conversions pures pdf.js ⇄ FormValue), core/forms/session.ts
  (FormSession : observation annotationStorage.setValue → modèle, sync modèle → storage + refresh des pages,
  étapes d'annulation par visite de champ), core/forms/scripting.ts (sandbox quickjs, non encore vérifié),
  controller ENABLE_FORMS + refreshForms, CSS widgets, bandeau « champs remplissables » + Surligner, reset = /DV.
  Vérifié Playwright CSP 3250 : 14 contrôles à l'ouverture sur form-acro, saisie Unicode, undo/redo par étape OK.

## En cours

## Reste

## Décisions
- FormValue = string | boolean(legacy) | string[] ; case/radio = valeur d'export cochée ou "Off".
- pdf.js saveDocument NE génère PAS d'apparence pour un caractère hors police du /DA (renvoie needAppearances,
  retire /AP, pose NeedAppearances true) → post-passe Elium : apparences pdf-lib avec LiberationSans (assets pdf.js
  standard_fonts) ou police importée ; CJK sans police → avertissement.

## Mesures
