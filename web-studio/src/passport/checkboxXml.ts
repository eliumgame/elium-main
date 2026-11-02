/**
 * Conversion des cases à cocher Word (contrôles w14:checkbox, champs FORMCHECKBOX hérités, symboles Wingdings)
 * en ☒ / ☐ dans `word/document.xml`, avant la conversion en texte qui les effacerait.
 *
 * Parcours LINÉAIRE par `indexOf` : les anciennes expressions régulières à motifs tempérés imbriqués
 * (`(?:(?!<\/w:r>)[\s\S])*?<w:ffData>…`) repartaient jusqu'à la fin du document pour chaque `<w:r>` quand les
 * balises fermantes manquaient — complexité cubique, onglet figé sur une fiche piégée de quelques centaines de Ko.
 * Ici chaque recherche de balise avance de façon monotone (curseur mémorisé) : le coût total reste O(n) quelle que
 * soit l'entrée, avec le même résultat que les anciennes expressions sur un document Word bien formé.
 */

const run = (c: boolean) => `<w:r><w:t>${c ? "☒" : "☐"}</w:t></w:r>`;
const on = (v: string | undefined) => v === undefined || /^(1|true|on)$/i.test(v);

/**
 * Recherche « prochaine occurrence ≥ pos » pour des positions croissantes : le dernier résultat est réutilisé tant
 * qu'il reste devant la position demandée, si bien que l'ensemble des appels ne parcourt la chaîne qu'une fois.
 * Une position plus petite que la précédente relance simplement une recherche (correct, mais non amorti).
 */
function nextFinder(s: string, needle: string): (pos: number) => number {
  let lastPos = -1;
  let lastRes = -2; // -2 = rien en cache
  return (pos) => {
    if (lastRes !== -2 && pos >= lastPos && (lastRes === -1 || lastRes >= pos)) {
      lastPos = pos;
      return lastRes;
    }
    lastPos = pos;
    lastRes = s.indexOf(needle, pos);
    return lastRes;
  };
}

/** Texte de la balise ouvrante commençant en `start` (jusqu'au premier `>` inclus), ou null si elle n'est pas fermée. */
function tagAt(s: string, start: number, nextGt: (p: number) => number): { end: number; text: string } | null {
  const gt = nextGt(start);
  if (gt === -1) return null;
  return { end: gt + 1, text: s.slice(start, gt + 1) };
}

const isTagBoundary = (ch: string | undefined) => ch === ">" || ch === "/" || (ch !== undefined && /\s/.test(ch));

/** Valeur d'attribut (dernière occurrence, comme l'ancien `[^>]*attr="…"` glouton) dans le texte d'UNE balise. */
function lastAttr(tag: string, attr: string): string | undefined {
  const key = `${attr}="`;
  const i = tag.lastIndexOf(key);
  if (i === -1) return undefined;
  const j = tag.indexOf('"', i + key.length);
  return j === -1 ? undefined : tag.slice(i + key.length, j);
}

/** 1. Contrôles de contenu « case à cocher » : `<w:sdt>…<w14:checkbox>…</w:sdt>` (sdt le plus interne). */
function convertSdtCheckboxes(x: string): string {
  const OPEN = "<w:sdt>";
  const CLOSE = "</w:sdt>";
  const nextOpen = nextFinder(x, OPEN);
  const nextClose = nextFinder(x, CLOSE);
  const out: string[] = [];
  let copied = 0;
  let i = nextOpen(0);
  while (i !== -1) {
    const close = nextClose(i + OPEN.length);
    if (close === -1) break; // plus aucune fermeture : aucune correspondance possible plus loin
    const reopen = nextOpen(i + OPEN.length);
    if (reopen !== -1 && reopen < close) {
      i = reopen; // un sdt imbriqué s'ouvre avant la fermeture : seul le plus interne peut correspondre
      continue;
    }
    const end = close + CLOSE.length;
    const m = x.slice(i, end);
    if (m.includes("<w14:checkbox")) {
      let checked: string | undefined;
      // Première balise <w14:checked …> portant w14:val (l'ancien motif prenait la première).
      for (let k = m.indexOf("<w14:checked"); k !== -1; k = m.indexOf("<w14:checked", k + 1)) {
        if (!isTagBoundary(m[k + 12])) continue;
        const gt = m.indexOf(">", k);
        if (gt === -1) break;
        const v = lastAttr(m.slice(k, gt), "w14:val");
        if (v !== undefined) {
          checked = v;
          break;
        }
      }
      out.push(x.slice(copied, i), run(checked !== undefined && on(checked)));
      copied = end;
    }
    i = nextOpen(end);
  }
  if (copied === 0) return x;
  out.push(x.slice(copied));
  return out.join("");
}

/** Valeur cochée d'un champ FORMCHECKBOX d'après le contenu de son `<w:checkBox>`. */
function formCheckboxValue(cb: string): boolean {
  let chk: { val?: string } | null = null;
  for (let k = cb.indexOf("<w:checked"); k !== -1; k = cb.indexOf("<w:checked", k + 1)) {
    if (!isTagBoundary(cb[k + 10])) continue;
    const gt = cb.indexOf(">", k);
    if (gt === -1) break;
    const tag = cb.slice(k, gt + 1);
    if (!tag.endsWith("/>")) continue; // l'ancien motif exigeait une balise auto-fermante
    chk = { val: lastAttr(tag, "w:val") };
    break;
  }
  if (chk) return on(chk.val);
  for (let k = cb.indexOf("<w:default"); k !== -1; k = cb.indexOf("<w:default", k + 1)) {
    if (!isTagBoundary(cb[k + 10])) continue;
    const gt = cb.indexOf(">", k);
    if (gt === -1) break;
    const def = lastAttr(cb.slice(k, gt), "w:val");
    if (def !== undefined) return on(def);
  }
  return false;
}

/** 2. Champs de formulaire hérités : un `<w:r>` dont un `<w:ffData>` contient `<w:checkBox>`. */
function convertFormCheckboxes(x: string): string {
  const nextR = nextFinder(x, "<w:r");
  const nextGt = nextFinder(x, ">");
  const nextRunEnd = nextFinder(x, "</w:r>");
  const nextRunEndAfterFf = nextFinder(x, "</w:r>");
  const nextFf = nextFinder(x, "<w:ffData>");
  const nextFfEnd = nextFinder(x, "</w:ffData>");
  const nextCb = nextFinder(x, "<w:checkBox>");

  // Pré-calcul (une passe, positions croissantes) des <w:ffData> qui contiennent une case et de la fin du run.
  const hits: { ff: number; cb: number; ffEnd: number; end: number }[] = [];
  for (let ff = nextFf(0); ff !== -1; ff = nextFf(ff + 1)) {
    const inner = ff + "<w:ffData>".length;
    const cb = nextCb(inner);
    if (cb === -1) break;
    const ffEnd = nextFfEnd(inner);
    if (ffEnd === -1) break;
    if (cb > ffEnd) continue;
    const rEnd = nextRunEndAfterFf(ffEnd + "</w:ffData>".length);
    if (rEnd === -1) break;
    hits.push({ ff, cb, ffEnd, end: rEnd + "</w:r>".length });
  }
  if (hits.length === 0) return x;

  const out: string[] = [];
  let copied = 0;
  let h = 0;
  let r = nextR(0);
  while (r !== -1 && h < hits.length) {
    const ch = x[r + 4];
    let openEnd: number;
    if (ch === ">") openEnd = r + 5;
    else if (ch !== undefined && /\s/.test(ch)) {
      const tag = tagAt(x, r, nextGt);
      if (!tag) break;
      openEnd = tag.end;
    } else {
      r = nextR(r + 1); // <w:rPr>, <w:rFonts>… : pas un run
      continue;
    }
    while (h < hits.length && hits[h].ff < openEnd) h++;
    if (h >= hits.length) break;
    const runEnd = nextRunEnd(openEnd);
    const hit = hits[h];
    if (runEnd !== -1 && runEnd < hit.ff) {
      r = nextR(r + 1); // ce run se ferme avant toute case : run suivant
      continue;
    }
    const cbOpen = hit.cb + "<w:checkBox>".length;
    const cbClose = x.indexOf("</w:checkBox>", cbOpen);
    const cbBody = cbClose === -1 || cbClose > hit.end ? "" : x.slice(cbOpen, cbClose);
    out.push(x.slice(copied, r), run(formCheckboxValue(cbBody)));
    copied = hit.end;
    r = nextR(hit.end);
  }
  if (copied === 0) return x;
  out.push(x.slice(copied));
  return out.join("");
}

const SYM_CHECKED = ["F0FE", "F0FD", "F0FC", "F078", "F0FB"];
const SYM_UNCHECKED = ["F0A8", "F06F", "F0A3", "F071"];

/** 3. Symboles Wingdings `<w:sym … w:char="F0FE"/>`. */
function convertSymbols(x: string): string {
  const nextSym = nextFinder(x, "<w:sym");
  const nextGt = nextFinder(x, ">");
  const out: string[] = [];
  let copied = 0;
  for (let i = nextSym(0); i !== -1;) {
    if (!/\s/.test(x[i + 6] ?? "")) {
      i = nextSym(i + 1);
      continue;
    }
    const tag = tagAt(x, i, nextGt);
    if (!tag) break;
    const c = tag.text.endsWith("/>") ? lastAttr(tag.text, "w:char") : undefined;
    if (c && /^[0-9A-Fa-f]{4}$/.test(c)) {
      const u = c.toUpperCase();
      const rep = SYM_CHECKED.includes(u) ? "<w:t>☒</w:t>" : SYM_UNCHECKED.includes(u) ? "<w:t>☐</w:t>" : null;
      if (rep) {
        out.push(x.slice(copied, i), rep);
        copied = tag.end;
      }
    }
    i = nextSym(tag.end);
  }
  if (copied === 0) return x;
  out.push(x.slice(copied));
  return out.join("");
}

/** Remplace les cases Word de `document.xml` par ☒ / ☐ ; renvoie la chaîne d'origine si rien n'est converti. */
export function convertCheckboxXml(xml: string): string {
  let x = xml;
  if (x.includes("<w14:checkbox")) x = convertSdtCheckboxes(x);
  if (x.includes("<w:checkBox>")) x = convertFormCheckboxes(x);
  if (x.includes("<w:sym")) x = convertSymbols(x);
  return x;
}
