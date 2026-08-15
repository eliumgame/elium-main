/**
 * Page Documentation in-app — source unique de la doc Elium.
 *
 * Le contenu (markdown consolidé) vit dans `documentation.ts` (module TS, pas de
 * fichier .md épars). Rendu par un petit moteur markdown maison (le projet évite
 * les dépendances) : titres, paragraphes, listes, tables, code, citations, liens.
 * Sommaire latéral filtrable + défilement vers les ancres. Thème clair/sombre via
 * les jetons `--el-*` de la charte.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Home, Search, BookOpen, ChevronRight } from "lucide-react";
import { DOCUMENTATION_MD } from "./documentation";
import "./documentation.css";

interface TocItem {
  id: string;
  text: string;
  level: number;
}

// Slug façon GitHub (les ancres du sommaire markdown sont écrites ainsi) :
// minuscule, on RETIRE la ponctuation mais on GARDE les accents, espaces → tirets
// SANS fusionner les tirets (« Signatures — Elium Sign » → « signatures--elium-sign »).
function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Rendu des styles inline : `code`, **gras**, *italique*, [texte](url). */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Ordre : code (protège son contenu), **gras**, *ital*, _ital_ (bornes de mot
  // pour épargner SNAKE_CASE), [lien](url).
  const re = /(`[^`]+`|\*\*[^*]+?\*\*|\*[^*\s][^*]*?\*|(?<![\w*])_[^_]+?_(?!\w)|\[[^\]]+\]\([^)]+\))/g;
  let last = 0,
    i = 0,
    m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) out.push(<code key={key + i}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={key + i}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("*")) out.push(<em key={key + i}>{t.slice(1, -1)}</em>);
    else if (t.startsWith("_")) out.push(<em key={key + i}>{t.slice(1, -1)}</em>);
    else {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
      const href = lm[2]!;
      const external = /^https?:\/\//.test(href);
      out.push(
        <a key={key + i} href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
          {lm[1]}
        </a>,
      );
    }
    last = m.index + t.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface Parsed {
  blocks: ReactNode[];
  toc: TocItem[];
}

function parseMarkdown(md: string): Parsed {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  const toc: TocItem[] = [];
  let i = 0,
    k = 0;
  const key = () => `b${k++}`;
  // Une ligne (sans son indentation) démarre-t-elle un nouveau bloc ?
  const isBlockStart = (l: string) => {
    const tl = l.trimStart();
    return tl === "" || tl.startsWith("|") || /^(#{1,4}\s|`{2,}|>|([-*+]|\d+\.)\s)/.test(tl);
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Titre
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!.trim();
      const id = slug(text);
      if (level === 2 || level === 3) toc.push({ id, text, level });
      const Tag = `h${Math.min(level, 4)}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(
        <Tag key={key()} id={id} className={`doc-h doc-h${level}`}>
          {inline(text, id)}
        </Tag>,
      );
      i++;
      continue;
    }

    // Bloc de code : fence ``` (tolère l'INDENTATION — fences sous des listes —
    // et une coquille à 2 backticks). Ouverture = une ligne qui n'est QUE des
    // backticks (2+) suivis d'un langage optionnel. Le contenu est dédenté de
    // l'indentation de l'ouverture.
    const openFence = /^(\s*)(`{2,})[ \t]*([\w-]*)[ \t]*$/.exec(line);
    if (openFence) {
      const indent = openFence[1]!.length;
      const lang = openFence[3]!;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*`{2,}[ \t]*$/.test(lines[i]!)) {
        buf.push(lines[i]!.slice(indent));
        i++;
      }
      i++; // ferme la fence
      blocks.push(
        <pre key={key()} className="doc-pre">
          <code data-lang={lang}>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Table |---|
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!) &&
      lines[i + 1]!.includes("-")
    ) {
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(cells(lines[i]!));
        i++;
      }
      blocks.push(
        <div key={key()} className="doc-tablewrap">
          <table className="doc-table">
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci}>{inline(c, `th${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{inline(c, `td${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Règle horizontale
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(<hr key={key()} className="doc-hr" />);
      i++;
      continue;
    }

    // Citation
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        buf.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key()} className="doc-quote">
          {inline(buf.join(" "), "q")}
        </blockquote>,
      );
      continue;
    }

    // Liste (ordonnée / non ordonnée). Gère les items REPLIÉS sur plusieurs
    // lignes : une ligne indentée qui n'est pas un nouveau marqueur ni un autre
    // bloc est rattachée à l'item courant (sinon un **gras** à cheval sur le
    // repli fuit).
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
          items.push(l.replace(/^\s*([-*+]|\d+\.)\s+/, ""));
          i++;
        } else if (items.length && l.trim() !== "" && /^\s/.test(l) && !isBlockStart(l)) {
          items[items.length - 1] += " " + l.trim();
          i++;
        } else break;
      }
      const lis = items.map((it, ii) => <li key={ii}>{inline(it, `li${ii}`)}</li>);
      blocks.push(
        ordered ? (
          <ol key={key()} className="doc-ol">
            {lis}
          </ol>
        ) : (
          <ul key={key()} className="doc-ul">
            {lis}
          </ul>
        ),
      );
      continue;
    }

    // Paragraphe (lignes consécutives). On s'arrête sur tout marqueur de bloc,
    // même INDENTÉ (isBlockStart teste la ligne sans son indentation).
    const buf: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i]!)) {
      buf.push(lines[i]!);
      i++;
    }
    if (buf.length)
      blocks.push(
        <p key={key()} className="doc-p">
          {inline(buf.join(" "), "p")}
        </p>,
      );
    else i++;
  }
  return { blocks, toc };
}

interface Section {
  h2: TocItem;
  children: TocItem[];
}

export default function DocumentationView({ onHome }: { onHome: () => void }) {
  const { blocks, toc } = useMemo(() => parseMarkdown(DOCUMENTATION_MD), []);
  const [q, setQ] = useState("");
  const [activeId, setActiveId] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  // Arbre du sommaire : chaque H2 porte ses H3 (repliés sauf section active).
  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    for (const t of toc) {
      if (t.level === 2 || out.length === 0) out.push({ h2: t, children: [] });
      else out[out.length - 1]!.children.push(t);
    }
    return out;
  }, [toc]);

  // Résultats filtrés (recherche) : liste plate lisible.
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? toc.filter((t) => t.text.toLowerCase().includes(s)) : null;
  }, [q, toc]);

  const jump = (id: string) => {
    bodyRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
  };

  // Scroll-spy : surligne (et déplie) la section réellement à l'écran.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = () => {
      const hs = Array.from(body.querySelectorAll<HTMLElement>(".doc-h2, .doc-h3"));
      const base = body.getBoundingClientRect().top;
      let cur = hs[0]?.id ?? "";
      for (const h of hs) {
        if (h.getBoundingClientRect().top - base <= 110) cur = h.id;
        else break;
      }
      setActiveId(cur);
    };
    onScroll();
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [blocks]);

  const docTitle = useMemo(() => (/^#\s+(.*)$/m.exec(DOCUMENTATION_MD)?.[1] ?? "Documentation Elium").trim(), []);
  useEffect(() => {
    document.title = `${docTitle} — Elium`;
  }, [docTitle]);

  return (
    <div className="doc-page">
      <aside className="doc-toc">
        <div className="doc-toc__brand">
          <BookOpen size={18} /> <span>Documentation</span>
        </div>
        <label className="doc-search">
          <Search size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher une section…"
            aria-label="Rechercher"
          />
        </label>
        <nav className="doc-toc__nav">
          {filtered ? (
            filtered.length === 0 ? (
              <p className="doc-toc__empty">Aucune section.</p>
            ) : (
              filtered.map((t) => (
                <button
                  key={t.id}
                  className={`doc-toc__link doc-toc__link--l${t.level} ${t.id === activeId ? "is-active" : ""}`}
                  onClick={() => jump(t.id)}
                >
                  {t.text}
                </button>
              ))
            )
          ) : (
            sections.map((sec) => {
              const open = sec.h2.id === activeId || sec.children.some((c) => c.id === activeId);
              return (
                <div key={sec.h2.id} className="doc-toc__section">
                  <button
                    className={`doc-toc__h2 ${sec.h2.id === activeId ? "is-active" : ""}`}
                    onClick={() => jump(sec.h2.id)}
                  >
                    {sec.children.length > 0 ? (
                      <ChevronRight size={14} className={`doc-toc__chev ${open ? "is-open" : ""}`} />
                    ) : (
                      <span className="doc-toc__chev-spacer" />
                    )}
                    <span>{sec.h2.text}</span>
                  </button>
                  {open &&
                    sec.children.map((c) => (
                      <button
                        key={c.id}
                        className={`doc-toc__h3 ${c.id === activeId ? "is-active" : ""}`}
                        onClick={() => jump(c.id)}
                      >
                        {c.text}
                      </button>
                    ))}
                </div>
              );
            })
          )}
        </nav>
        <button className="eb eb--sm eb--ghost doc-toc__home" onClick={onHome}>
          <Home size={15} /> Accueil
        </button>
      </aside>
      <main className="doc-body" ref={bodyRef}>
        <article className="doc-content">{blocks}</article>
      </main>
    </div>
  );
}
