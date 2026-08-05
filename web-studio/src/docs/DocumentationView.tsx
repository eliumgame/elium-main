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
import { Home, Search, BookOpen } from "lucide-react";
import { DOCUMENTATION_MD } from "./documentation";
import "./documentation.css";

interface TocItem { id: string; text: string; level: number; }

function slug(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
}

/** Rendu des styles inline : `code`, **gras**, *italique*, [texte](url). */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, i = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) out.push(<code key={key + i}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={key + i}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("*")) out.push(<em key={key + i}>{t.slice(1, -1)}</em>);
    else {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
      const href = lm[2]!;
      const external = /^https?:\/\//.test(href);
      out.push(<a key={key + i} href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>{lm[1]}</a>);
    }
    last = m.index + t.length; i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface Parsed { blocks: ReactNode[]; toc: TocItem[]; }

function parseMarkdown(md: string): Parsed {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  const toc: TocItem[] = [];
  let i = 0, k = 0;
  const key = () => `b${k++}`;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") { i++; continue; }

    // Titre
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!.trim();
      const id = slug(text);
      if (level === 2 || level === 3) toc.push({ id, text, level });
      const Tag = (`h${Math.min(level, 4)}`) as "h1" | "h2" | "h3" | "h4";
      blocks.push(<Tag key={key()} id={id} className={`doc-h doc-h${level}`}>{inline(text, id)}</Tag>);
      i++; continue;
    }

    // Bloc de code ```
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) { buf.push(lines[i]!); i++; }
      i++; // ferme ```
      blocks.push(<pre key={key()} className="doc-pre"><code data-lang={lang}>{buf.join("\n")}</code></pre>);
      continue;
    }

    // Table |---|
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) { rows.push(cells(lines[i]!)); i++; }
      blocks.push(
        <div key={key()} className="doc-tablewrap"><table className="doc-table">
          <thead><tr>{header.map((c, ci) => <th key={ci}>{inline(c, `th${ci}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `td${ri}-${ci}`)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }

    // Règle horizontale
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { blocks.push(<hr key={key()} className="doc-hr" />); i++; continue; }

    // Citation
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) { buf.push(lines[i]!.replace(/^>\s?/, "")); i++; }
      blocks.push(<blockquote key={key()} className="doc-quote">{inline(buf.join(" "), "q")}</blockquote>);
      continue;
    }

    // Liste (ordonnée / non ordonnée)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*+]|\d+\.)\s+/, "")); i++;
      }
      const lis = items.map((it, ii) => <li key={ii}>{inline(it, `li${ii}`)}</li>);
      blocks.push(ordered ? <ol key={key()} className="doc-ol">{lis}</ol> : <ul key={key()} className="doc-ul">{lis}</ul>);
      continue;
    }

    // Paragraphe (lignes consécutives)
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+\.)\s)/.test(lines[i]!) && !lines[i]!.trim().startsWith("|")) {
      buf.push(lines[i]!); i++;
    }
    if (buf.length) blocks.push(<p key={key()} className="doc-p">{inline(buf.join(" "), "p")}</p>);
    else i++;
  }
  return { blocks, toc };
}

export default function DocumentationView({ onHome }: { onHome: () => void }) {
  const { blocks, toc } = useMemo(() => parseMarkdown(DOCUMENTATION_MD), []);
  const [q, setQ] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  const filteredToc = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? toc.filter((t) => t.text.toLowerCase().includes(s)) : toc;
  }, [q, toc]);

  const jump = (id: string) => {
    const el = bodyRef.current?.querySelector(`#${CSS.escape(id)}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Titre du document (premier # ) pour l'en-tête.
  const docTitle = useMemo(() => (/^#\s+(.*)$/m.exec(DOCUMENTATION_MD)?.[1] ?? "Documentation Elium").trim(), []);

  useEffect(() => { document.title = `${docTitle} — Elium`; }, [docTitle]);

  return (
    <div className="doc-page">
      <aside className="doc-toc">
        <div className="doc-toc__brand"><BookOpen size={18} /> <span>Documentation</span></div>
        <label className="doc-search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer les sections…" aria-label="Filtrer" />
        </label>
        <nav className="doc-toc__nav">
          {filteredToc.map((t) => (
            <button key={t.id} className={`doc-toc__item doc-toc__item--l${t.level}`} onClick={() => jump(t.id)}>{t.text}</button>
          ))}
          {filteredToc.length === 0 && <p className="doc-toc__empty">Aucune section.</p>}
        </nav>
        <button className="eb eb--sm eb--ghost doc-toc__home" onClick={onHome}><Home size={15} /> Accueil</button>
      </aside>
      <main className="doc-body" ref={bodyRef}>
        <article className="doc-content">{blocks}</article>
      </main>
    </div>
  );
}
