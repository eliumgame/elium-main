/**
 * La morphologie française : de quelques milliers de mots de base à toutes leurs
 * formes.
 *
 * **Pourquoi générer plutôt qu'embarquer une liste.** Un dictionnaire français
 * fléchi pèse plusieurs mégaoctets ; l'embarquer alourdirait le paquet et
 * l'application entière pour un seul module. Les règles de flexion, elles, tiennent
 * en quelques centaines de lignes et produisent les mêmes formes : un lexique de
 * 6 000 entrées donne ici plus de 100 000 formes, conjugaisons comprises. Le
 * dictionnaire est donc **calculé au premier usage**, pas transporté.
 *
 * **Le parti pris sur les cas douteux : sur-générer.** Quand l'orthographe admet
 * deux formes (« paye »/« paie », « appelle »/« appèle », « clefs »/« clés »), les
 * deux sont produites. Un correcteur qui souligne un mot correct fait cesser de
 * regarder les soulignements — c'est la panne la plus grave d'un correcteur, bien
 * pire que laisser passer une forme rare et fautive.
 *
 * Tout est pur : des chaînes en entrée, un ensemble de chaînes en sortie. Aucune
 * dépendance, testable sans navigateur.
 */

// =========================================================================
// Terminaisons
// =========================================================================

/** Les terminaisons du 1er groupe, sur le radical (infinitif sans « er »). */
const ER = {
  /** Formes à terminaison « muette » : c'est là que jouent les alternances é→è, l→ll, t→tt. */
  silent: ["e", "es", "e", "ent"],
  loud: ["ons", "ez"],
  imperfect: ["ais", "ait", "ions", "iez", "aient"],
  past: ["ai", "as", "a", "âmes", "âtes", "èrent"],
  /** Futur et conditionnel : bâtis sur l'infinitif entier. */
  future: ["ai", "as", "a", "ons", "ez", "ont"],
  conditional: ["ais", "ait", "ions", "iez", "aient"],
  subjImperfect: ["asse", "asses", "ât", "assions", "assiez", "assent"],
} as const;

/** Les terminaisons du 2e groupe (finir : radical + « iss »). */
const IR2 = {
  present: ["is", "is", "it", "issons", "issez", "issent"],
  imperfect: ["issais", "issait", "issions", "issiez", "issaient"],
  past: ["is", "it", "îmes", "îtes", "irent"],
  subj: ["isse", "isses", "issions", "issiez", "issent"],
  subjImperfect: ["isse", "isses", "ît", "issions", "issiez", "issent"],
  participle: ["issant", "i", "is", "ie", "ies"],
} as const;

/** Les quatre accords d'un participe passé ou d'un adjectif. */
function agree(base: string): string[] {
  // Un participe en -é s'accorde en genre et en nombre ; en -i et -u aussi.
  return [base, `${base}s`, `${base}e`, `${base}es`];
}

// =========================================================================
// Alternances du 1er groupe
// =========================================================================

/** Les radicaux « muets » possibles d'un verbe en -er (alternances comprises). */
function silentStems(inf: string): string[] {
  const stem = inf.slice(0, -2);
  const out = new Set<string>([stem]);

  // é → è devant une terminaison muette : céder → cède, préférer → préfère.
  const eAcute = stem.replace(/é([^é]*)$/, "è$1");
  if (eAcute !== stem) out.add(eAcute);
  // e → è : lever → lève, acheter → achète, semer → sème.
  const eMute = stem.replace(/e([bcdfgjkmnpqrstvxz]+)$/, "è$1");
  if (eMute !== stem) out.add(eMute);
  // Redoublement : appeler → appelle, jeter → jette. Les deux orthographes sont
  // admises depuis 1990 pour la plupart des verbes ; on accepte les deux.
  const doubled = stem.replace(/e([lt])$/, "e$1$1");
  if (doubled !== stem) out.add(doubled);
  // y → i : employer → emploie, essuyer → essuie, payer → paie (et « paye »).
  const yToI = stem.replace(/y$/, "i");
  if (yToI !== stem) out.add(yToI);

  return [...out];
}

/** Le radical devant une terminaison en a/o : plaçons, mangeons. */
function loudStem(inf: string): string {
  const stem = inf.slice(0, -2);
  if (/c$/.test(stem)) return `${stem.slice(0, -1)}ç`;
  if (/g$/.test(stem)) return `${stem}e`;
  return stem;
}

/** Les radicaux du futur et du conditionnel (bâtis sur l'infinitif). */
function futureStems(inf: string): string[] {
  const out = new Set<string>([inf]);
  const stem = inf.slice(0, -2);
  // Le futur suit l'alternance du présent : j'achèterai, j'appellerai, j'emploierai.
  for (const s of silentStems(inf)) if (s !== stem) out.add(`${s}er`);
  return [...out];
}

/**
 * Toutes les formes d'un verbe du 1er groupe.
 *
 * Le 1er groupe couvre à lui seul l'immense majorité des verbes français, y
 * compris tous les néologismes : le traiter par règles, et non par liste de
 * formes, est ce qui permet à « télétravailler » d'être reconnu sans figurer dans
 * aucun lexique.
 */
export function conjugateEr(inf: string): string[] {
  const out = new Set<string>([inf]);
  const stem = inf.slice(0, -2);
  const loud = loudStem(inf);

  for (const s of silentStems(inf)) for (const end of ER.silent) out.add(s + end);
  for (const end of ER.loud) out.add(loud + end);
  // L'imparfait et le participe présent prennent le radical « en a/o » : je
  // mangeais, en plaçant.
  for (const end of ER.imperfect) out.add(loud + end);
  out.add(`${loud}ant`);
  for (const end of ER.past) out.add(loud + end);
  for (const end of ER.subjImperfect) out.add(loud + end);
  for (const f of futureStems(inf)) {
    for (const end of ER.future) out.add(f + end);
    for (const end of ER.conditional) out.add(f + end);
  }
  // Subjonctif présent : mêmes formes que l'indicatif pour les personnes muettes,
  // radical « en a/o » aux 1re et 2e du pluriel (que nous mangions).
  out.add(`${loud}ions`);
  out.add(`${loud}iez`);
  for (const p of agree(`${stem}é`)) out.add(p);
  return [...out];
}

/** Toutes les formes d'un verbe du 2e groupe (finir, choisir, réussir…). */
export function conjugateIr2(inf: string): string[] {
  const stem = inf.slice(0, -2);
  const out = new Set<string>([inf]);
  for (const end of [...IR2.present, ...IR2.imperfect, ...IR2.subj, ...IR2.subjImperfect, ...IR2.participle]) {
    out.add(stem + end);
  }
  for (const end of IR2.past) out.add(stem + end);
  for (const end of ER.future) out.add(`${inf}${end}`);
  for (const end of ER.conditional) out.add(`${inf}${end}`);
  return [...out];
}

// =========================================================================
// 3e groupe : familles de conjugaison
// =========================================================================

/**
 * Une famille du 3e groupe.
 *
 * `suffix` reconnaît l'infinitif, `cut` dit combien de lettres retirer pour
 * obtenir le radical, et les listes donnent les terminaisons. Raisonner par
 * FAMILLE et non par verbe est ce qui permet de couvrir « répondre », « confondre »
 * et « mordre » avec les mêmes six lignes que « attendre ».
 */
interface Family {
  suffix: RegExp;
  /** Lettres retirées de l'infinitif pour obtenir le radical. */
  cut: number;
  /** Présent : je, tu, il, nous, vous, ils — sur le radical. */
  present: string[];
  /**
   * Radical des trois personnes du singulier, quand il perd une lettre.
   *
   * C'est le cas de partir/dormir/servir : « je pars » mais « nous partons ». Le
   * traiter par une fonction évite une famille par consonne finale.
   */
  singularStem?: (stem: string) => string;
  /** Participe passé (accordé automatiquement). */
  pp: string;
  /** Radical du futur/conditionnel, sans le « r » final. */
  future: (inf: string) => string;
  /** Suffixe du participe présent (il donne aussi l'imparfait et le subjonctif). */
  gerund?: string;
  /** Passé simple. */
  past?: string[];
  /** Subjonctif présent, quand il ne suit pas le radical du participe présent. */
  subj?: string[];
}

/**
 * Les familles, de la plus SPÉCIFIQUE à la plus générale.
 *
 * L'ordre est significatif : « prendre » finit par « endre » comme « attendre »,
 * mais ne se conjugue pas comme lui (« nous prenons », pas « prendons »). La
 * première famille qui reconnaît l'infinitif gagne — mettre les familles générales
 * en tête produirait des conjugaisons fausses, et silencieusement.
 */
const FAMILIES: Family[] = [
  // prendre, comprendre, apprendre, entreprendre, surprendre. Radical « pr » : il
  // est le seul qui rende à la fois « prends » (pr+ends), « prenons » (pr+enons),
  // « prennent » et « pris » (pr+is). Un radical « pren » casserait le participe.
  {
    suffix: /prendre$/,
    cut: 5,
    present: ["ends", "ends", "end", "enons", "enez", "ennent"],
    pp: "is",
    future: (inf) => inf.slice(0, -1),
    gerund: "enant",
    past: ["is", "is", "it", "îmes", "îtes", "irent"],
    subj: ["enne", "ennes", "enions", "eniez", "ennent"],
  },
  // mettre, permettre, promettre, admettre, transmettre... participe « mis ».
  {
    suffix: /mettre$/,
    cut: 5,
    present: ["ets", "ets", "et", "ettons", "ettez", "ettent"],
    pp: "is",
    future: (inf) => inf.slice(0, -1),
    gerund: "ettant",
    past: ["is", "is", "it", "îmes", "îtes", "irent"],
  },
  // battre, combattre, debattre, abattre.
  {
    suffix: /battre$/,
    cut: 5,
    present: ["ats", "ats", "at", "attons", "attez", "attent"],
    pp: "attu",
    future: (inf) => inf.slice(0, -1),
    gerund: "attant",
    past: ["attis", "attis", "attit", "attîmes", "attîtes", "attirent"],
  },
  // venir, tenir et leurs composes : trois radicaux (viens, venons, viendrai).
  {
    suffix: /(?:venir|tenir)$/,
    cut: 4,
    present: ["iens", "iens", "ient", "enons", "enez", "iennent"],
    pp: "enu",
    future: (inf) => `${inf.slice(0, -4)}iendr`,
    gerund: "enant",
    past: ["ins", "ins", "int", "înmes", "întes", "inrent"],
    subj: ["ienne", "iennes", "enions", "eniez", "iennent"],
  },
  // partir, sortir, dormir, sentir, servir, mentir : la consonne du radical tombe
  // au singulier (« je pars », « nous partons »).
  {
    suffix: /(?:tir|mir|vir)$/,
    cut: 2,
    present: ["s", "s", "t", "ons", "ez", "ent"],
    singularStem: (stem) => stem.slice(0, -1),
    pp: "i",
    // Un verbe en -ir bâtit son futur sur l'INFINITIF entier : partir → partirai,
    // partirions. Retirer le « r » (comme pour les -re) donnait « partiai ».
    future: (inf) => inf,
    gerund: "ant",
    past: ["is", "is", "it", "îmes", "îtes", "irent"],
  },
  // conduire, produire, construire, reduire, traduire, detruire, cuire, nuire.
  {
    suffix: /uire$/,
    cut: 2,
    present: ["s", "s", "t", "sons", "sez", "sent"],
    pp: "t",
    future: (inf) => inf.slice(0, -1),
    gerund: "sant",
    past: ["sis", "sis", "sit", "sîmes", "sîtes", "sirent"],
  },
  // craindre, joindre, peindre, atteindre, eteindre, plaindre.
  {
    suffix: /(?:aindre|eindre|oindre)$/,
    cut: 4,
    present: ["ns", "ns", "nt", "gnons", "gnez", "gnent"],
    pp: "nt",
    future: (inf) => inf.slice(0, -1),
    gerund: "gnant",
    past: ["gnis", "gnis", "gnit", "gnîmes", "gnîtes", "gnirent"],
  },
  // connaitre, paraitre, apparaitre, disparaitre.
  {
    suffix: /aître$/,
    cut: 5,
    present: ["ais", "ais", "aît", "aissons", "aissez", "aissent"],
    pp: "u",
    future: (inf) => inf.slice(0, -1),
    gerund: "aissant",
    past: ["us", "us", "ut", "ûmes", "ûtes", "urent"],
  },
  // recevoir, apercevoir, decevoir, percevoir, concevoir.
  {
    suffix: /cevoir$/,
    cut: 6,
    present: ["çois", "çois", "çoit", "cevons", "cevez", "çoivent"],
    pp: "çu",
    future: (inf) => `${inf.slice(0, -6)}cevr`,
    gerund: "cevant",
    past: ["çus", "çus", "çut", "çûmes", "çûtes", "çurent"],
    subj: ["çoive", "çoives", "cevions", "ceviez", "çoivent"],
  },
  // ecrire, decrire, inscrire, prescrire, souscrire.
  {
    suffix: /crire$/,
    cut: 4,
    present: ["ris", "ris", "rit", "rivons", "rivez", "rivent"],
    pp: "rit",
    future: (inf) => inf.slice(0, -1),
    gerund: "rivant",
    past: ["rivis", "rivis", "rivit", "rivîmes", "rivîtes", "rivirent"],
  },
  // vivre, survivre, revivre : participe « vecu ».
  {
    suffix: /vivre$/,
    cut: 4,
    present: ["is", "is", "it", "ivons", "ivez", "ivent"],
    pp: "écu",
    future: (inf) => inf.slice(0, -1),
    gerund: "ivant",
    past: ["écus", "écus", "écut", "écûmes", "écûtes", "écurent"],
  },
  // suivre, poursuivre.
  {
    suffix: /suivre$/,
    cut: 4,
    present: ["is", "is", "it", "ivons", "ivez", "ivent"],
    pp: "ivi",
    future: (inf) => inf.slice(0, -1),
    gerund: "ivant",
    past: ["ivis", "ivis", "ivit", "ivîmes", "ivîtes", "ivirent"],
  },
  // ouvrir, offrir, souffrir, couvrir : présent en -e comme le 1er groupe, mais
  // futur sur l'infinitif entier (ouvrir → ouvrirai, pas « ouvriai »).
  {
    suffix: /(?:vrir|frir)$/,
    cut: 3,
    present: ["re", "res", "re", "rons", "rez", "rent"],
    pp: "ert",
    future: (inf) => inf,
    gerund: "rant",
    past: ["ris", "ris", "rit", "rîmes", "rîtes", "rirent"],
  },
  // courir, concourir, parcourir, secourir : futur a deux r.
  {
    suffix: /courir$/,
    cut: 2,
    present: ["s", "s", "t", "ons", "ez", "ent"],
    pp: "u",
    future: (inf) => `${inf.slice(0, -2)}r`,
    gerund: "ant",
    past: ["us", "us", "ut", "ûmes", "ûtes", "urent"],
  },
  // lire, elire, relire.
  {
    suffix: /lire$/,
    cut: 3,
    present: ["is", "is", "it", "isons", "isez", "isent"],
    pp: "u",
    future: (inf) => inf.slice(0, -1),
    gerund: "isant",
    past: ["us", "us", "ut", "ûmes", "ûtes", "urent"],
  },
  // rire, sourire.
  {
    suffix: /rire$/,
    cut: 3,
    present: ["is", "is", "it", "ions", "iez", "ient"],
    pp: "i",
    future: (inf) => inf.slice(0, -1),
    gerund: "iant",
    past: ["is", "is", "it", "îmes", "îtes", "irent"],
  },
  // conclure, exclure, inclure.
  {
    suffix: /clure$/,
    cut: 3,
    present: ["us", "us", "ut", "uons", "uez", "uent"],
    pp: "us",
    future: (inf) => inf.slice(0, -1),
    gerund: "uant",
    past: ["us", "us", "ut", "ûmes", "ûtes", "urent"],
  },
  // rompre, interrompre, corrompre.
  {
    suffix: /rompre$/,
    cut: 3,
    present: ["ps", "ps", "pt", "pons", "pez", "pent"],
    pp: "pu",
    future: (inf) => inf.slice(0, -1),
    gerund: "pant",
    past: ["pis", "pis", "pit", "pîmes", "pîtes", "pirent"],
  },
  // attendre, descendre, entendre, perdre, rendre, répondre, mordre, tordre… — la
  // famille GÉNÉRALE en -endre, testée en DERNIER : « prendre » et « mettre » y
  // ressemblent sans s'y conjuguer, et c'est l'ordre qui les protège.
  {
    suffix: /(?:[aeiou]nd|erd|ord)re$/,
    cut: 2,
    present: ["s", "s", "", "ons", "ez", "ent"],
    pp: "u",
    future: (inf) => inf.slice(0, -1),
    past: ["is", "is", "it", "îmes", "îtes", "irent"],
  },
];

/**
 * Toutes les formes d'un verbe du 3e groupe, par famille.
 *
 * Rend `null` quand aucune famille ne reconnaît l'infinitif : l'appelant sait
 * alors qu'il faut une table explicite (cf. `IRREGULAR` dans le lexique) plutôt
 * que de produire des formes inventées.
 */
export function conjugateFamily(inf: string): string[] | null {
  const fam = FAMILIES.find((f) => f.suffix.test(inf));
  if (!fam) return null;
  const stem = inf.slice(0, inf.length - fam.cut);
  const out = new Set<string>([inf]);
  const singular = fam.singularStem ? fam.singularStem(stem) : stem;
  fam.present.forEach((end, i) => out.add((i < 3 ? singular : stem) + end));
  // Le radical du participe present porte aussi l'imparfait et, sauf exception,
  // le subjonctif : « nous attendions » et « que j'attende » en viennent tous deux.
  const gerundStem = fam.gerund ? stem + fam.gerund.replace(/ant$/, "") : stem;
  out.add(`${gerundStem}ant`);
  for (const end of ["ais", "ais", "ait", "ions", "iez", "aient"]) out.add(gerundStem + end);
  if (fam.subj) for (const end of fam.subj) out.add(stem + end);
  else for (const end of ["e", "es", "e", "ions", "iez", "ent"]) out.add(gerundStem + end);
  const fut = fam.future(inf);
  for (const end of ["ai", "as", "a", "ons", "ez", "ont"]) out.add(fut + end);
  for (const end of ["ais", "ait", "ions", "iez", "aient"]) out.add(fut + end);
  for (const end of fam.past ?? ["us", "us", "ut", "ûmes", "ûtes", "urent"]) out.add(stem + end);
  for (const p of agree(stem + fam.pp)) out.add(p);
  return [...out];
}

// =========================================================================
// Noms et adjectifs
// =========================================================================

/** Les pluriels d'un nom ou d'un adjectif (les deux quand l'usage hésite). */
export function pluralsFr(word: string): string[] {
  const w = word.trim();
  if (!w) return [];
  // Déjà au pluriel de forme : invariable (un cas, des cas ; une croix, des croix).
  if (/[sxz]$/.test(w)) return [w];
  const out = new Set<string>([w]);
  if (/(?:eau|au|eu)$/.test(w)) {
    out.add(`${w}x`);
    // pneus, bleus, landaus… : l'exception est fréquente, on accepte les deux.
    out.add(`${w}s`);
  } else if (/al$/.test(w)) {
    // chevaux, mais aussi bals, festivals, récitals : les deux sont produits.
    out.add(`${w.slice(0, -2)}aux`);
    out.add(`${w}s`);
  } else if (/ail$/.test(w)) {
    out.add(`${w}s`);
    // travaux, coraux, émaux, vitraux, baux.
    out.add(`${w.slice(0, -3)}aux`);
  } else if (/ou$/.test(w)) {
    out.add(`${w}s`);
    // bijoux, cailloux, choux, genoux, hiboux, joujoux, poux.
    out.add(`${w}x`);
  } else {
    out.add(`${w}s`);
  }
  return [...out];
}

/**
 * Les féminins d'un adjectif.
 *
 * Plusieurs familles se recouvrent (« complet » fait « complète », « muet » fait
 * « muette ») : les deux formes sont produites, faute de pouvoir trancher sans un
 * marquage manuel de chaque adjectif — et un adjectif correct souligné coûte plus
 * cher qu'un adjectif fautif accepté.
 */
export function femininesFr(word: string): string[] {
  const w = word.trim();
  if (!w) return [];
  const out = new Set<string>();
  if (/e$/.test(w)) {
    out.add(w); // égal au masculin : rouge, facile, utile.
  } else if (/er$/.test(w)) {
    out.add(`${w.slice(0, -2)}ère`); // léger → légère
  } else if (/et$/.test(w)) {
    out.add(`${w}te`); // muet → muette
    out.add(`${w.slice(0, -2)}ète`); // complet → complète
  } else if (/teur$/.test(w)) {
    out.add(`${w.slice(0, -4)}trice`); // acteur → actrice
    out.add(`${w.slice(0, -3)}euse`); // menteur → menteuse
  } else if (/(?:eux|eur)$/.test(w)) {
    out.add(`${w.slice(0, -3)}euse`); // heureux → heureuse
  } else if (/f$/.test(w)) {
    out.add(`${w.slice(0, -1)}ve`); // actif → active
  } else if (/(?:el|eil|ul|en|on|ien)$/.test(w)) {
    out.add(w + w.slice(-1) + "e"); // cruel → cruelle, ancien → ancienne
    // Mais « seul » fait « seule » et « plein » fait « pleine » : la famille ne
    // double pas toujours. Les deux formes sont produites — souligner « seule »
    // serait bien pire que d'accepter « seulle ».
    out.add(`${w}e`);
  } else if (/c$/.test(w)) {
    out.add(`${w.slice(0, -1)}que`); // public → publique
    out.add(`${w.slice(0, -1)}che`); // blanc → blanche
  } else if (/x$/.test(w)) {
    out.add(`${w.slice(0, -1)}se`); // jaloux → jalouse
    out.add(`${w.slice(0, -1)}sse`); // faux → fausse
  } else {
    out.add(`${w}e`);
  }
  return [...out];
}

/** Un nom avec ses pluriels. */
export function nounForms(word: string): string[] {
  return pluralsFr(word);
}

/**
 * L'adjectif en -able tiré d'un verbe du 1er groupe.
 *
 * « utilisable », « vérifiable », « récupérable », « paramétrable » : le suffixe est
 * l'un des plus productifs du français et se forme à la demande, donc aucun lexique
 * ne le contient en entier. Le dériver ici couvre des centaines d'adjectifs pour
 * quatre lignes — et les rares formes inexistantes qu'on accepte ainsi
 * (« parlable ») ne s'écrivent jamais par erreur.
 */
export function verbAdjectives(inf: string): string[] {
  if (!/er$/.test(inf) || inf.length < 5) return [];
  const stem = inf.slice(0, -2);
  // Le son se conserve : « déplaçable », « mangeable ».
  const base = /c$/.test(stem)
    ? `${stem.slice(0, -1)}çable`
    : /g$/.test(stem)
      ? `${stem}eable`
      : `${stem}able`;
  return [base, `${base}s`];
}

/** Un adjectif avec ses quatre accords (et ses variantes admises). */
export function adjectiveForms(word: string): string[] {
  const out = new Set<string>();
  for (const m of pluralsFr(word)) out.add(m);
  for (const f of femininesFr(word)) {
    out.add(f);
    for (const fp of pluralsFr(f)) out.add(fp);
  }
  return [...out];
}

/**
 * L'adverbe en -ment tiré d'un adjectif, quand la règle s'applique.
 *
 * « lent » → « lentement », « vrai » → « vraiment », « prudent » → « prudemment ».
 * Rend une liste (parfois vide) : tous les adjectifs n'en donnent pas, et deviner
 * vaut mieux que ne rien reconnaître — un adverbe manquant est un mot souligné à
 * tort.
 */
export function adverbsFr(adjective: string): string[] {
  const w = adjective.trim();
  if (!w || w.length < 3) return [];
  const out = new Set<string>();
  if (/ent$/.test(w)) out.add(`${w.slice(0, -3)}emment`); // prudent → prudemment
  else if (/ant$/.test(w)) out.add(`${w.slice(0, -3)}amment`); // constant → constamment
  const fem = femininesFr(w)[0];
  if (fem) out.add(`${fem.replace(/e$/, "")}ement`.replace(/eement$/, "ement"));
  if (/[aeiouéèy]$/.test(w)) out.add(`${w}ment`); // vrai → vraiment, poli → poliment
  return [...out].filter((a) => /ment$/.test(a) && a.length > w.length);
}

// =========================================================================
// Élisions et enclises
// =========================================================================

/**
 * Les formes élidées et à trait d'union construites sur un verbe conjugué.
 *
 * « c'est », « qu'il », « allons-y », « donne-moi », « est-ce » : ces mots
 * composés apparaissent partout dans un texte français et ne figurent dans aucun
 * lexique de base. Sans eux, le correcteur soulignerait la moitié des dialogues.
 */
export const ENCLITICS = [
  "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "moi", "toi", "lui", "leur",
  "y", "en", "le", "la", "les", "ce", "là",
] as const;

/** Vrai si le mot est une forme composée reconnue à partir d'un mot connu. */
export function splitCompound(word: string): string[] | null {
  const w = word.toLocaleLowerCase("fr");
  // Élision : l', d', qu', j', n', m', t', s', c'… suivie d'un mot.
  const elided = /^([cdjlmnstq]|qu|jusqu|lorsqu|puisqu|quoiqu)['’](.+)$/.exec(w);
  if (elided) return [elided[2]!];
  // Enclise : verbe-pronom, éventuellement double (« donne-le-moi »).
  if (w.includes("-")) {
    const parts = w.split("-");
    const head = parts[0]!;
    const tail = parts.slice(1);
    if (head && tail.length && tail.every((p) => (ENCLITICS as readonly string[]).includes(p) || p === "t")) {
      return [head];
    }
  }
  return null;
}
