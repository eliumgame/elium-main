import { isTiff } from "../ops/imagefile";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FileImage, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { Modal } from "../../ui/components";
import { imageKind, parsePageRange } from "../ops/organize";

/**
 * Acrobat's « Combiner des fichiers »: a list of PDFs and pictures, put in
 * order (drag, or the arrows), each whole or a page selection, then made into
 * one new document.
 */

export interface CombineItem {
  id: string;
  name: string;
  /** The file's bytes; absent for the open document (built when combining). */
  bytes?: Uint8Array;
  /** Pages in the file; null while counting, 0 when unreadable. */
  count: number | null;
  /** Page selection (« 1-3, 7 »); empty = all. */
  range: string;
  image: boolean;
}

let seq = 0;

/** A picture a PDF cannot embed as it is (WebP, GIF, BMP…) redrawn as PNG. */
async function asPng(file: File): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function readItem(file: File): Promise<CombineItem> {
  const id = `cf${++seq}`;
  let bytes: Uint8Array | null = new Uint8Array(await file.arrayBuffer());
  const isImage = file.type.startsWith("image/") || !!imageKind(bytes);
  // A TIFF (often a multi-page scan) becomes a PDF of its pages, each at its resolution.
  if (isTiff(bytes)) {
    try {
      const { pagePictures } = await import("./imagefiles");
      const { pdfFromImages } = await import("../ops/organize");
      const pictures = await pagePictures(file);
      const pdf = await pdfFromImages(
        pictures.map((p) => ({ src: p.src })),
        { pageSize: "fit" },
      );
      return { id, name: file.name, bytes: pdf, count: pictures.length, range: "", image: false };
    } catch {
      return { id, name: file.name, bytes: undefined, count: 0, range: "", image: true };
    }
  }
  if (isImage) {
    if (!imageKind(bytes)) bytes = await asPng(file);
    return { id, name: file.name, bytes: bytes ?? undefined, count: bytes ? 1 : 0, range: "", image: true };
  }
  let count = 0;
  try {
    const { PDFDocument } = await import("pdf-lib");
    // The page tree is readable even in a protected file.
    count = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
  } catch {
    count = 0;
  }
  return { id, name: file.name, bytes, count, range: "", image: false };
}

export function CombineDialog({
  current,
  initialFiles = [],
  onConfirm,
  onClose,
}: {
  /** The open document, offered as the first file. */
  current?: { name: string; count: number };
  initialFiles?: File[];
  onConfirm: (items: CombineItem[], opts: { outline: boolean }) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<CombineItem[]>(() =>
    current ? [{ id: "current", name: current.name, count: current.count, range: "", image: false }] : [],
  );
  const [pending, setPending] = useState(0);
  const [outline, setOutline] = useState(true);
  const [dragged, setDragged] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const add = async (files: File[]) => {
    if (!files.length) return;
    setPending((n) => n + files.length);
    for (const f of files) {
      const item = await readItem(f);
      setItems((list) => [...list, item]);
      setPending((n) => n - 1);
    }
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initialFiles.length) void add(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (id: string, to: number) =>
    setItems((list) => {
      const from = list.findIndex((x) => x.id === id);
      if (from < 0 || to < 0 || to >= list.length || from === to) return list;
      const next = list.slice();
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });
  const pagesOf = (it: CombineItem) =>
    it.count ? (it.range.trim() ? parsePageRange(it.range, it.count).length : it.count) : 0;
  const usable = items.filter((it) => pagesOf(it) > 0);
  const total = usable.reduce((n, it) => n + pagesOf(it), 0);

  return (
    <Modal
      title="Combiner des fichiers"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="pdfx-combine__total">
            {usable.length} fichier{usable.length > 1 ? "s" : ""} · {total} page{total > 1 ? "s" : ""}
          </span>
          <button className="eb eb--outline eb--sm" onClick={onClose}>
            Annuler
          </button>
          <button
            className="eb eb--primary eb--sm"
            disabled={!usable.length || pending > 0}
            onClick={() => onConfirm(usable, { outline })}
          >
            Combiner
          </button>
        </>
      }
    >
      <div
        className="pdfx-combine"
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          void add(Array.from(e.dataTransfer.files));
        }}
      >
        {items.length === 0 && !pending ? (
          <p className="pdfx-combine__empty">Ajoutez des PDF ou des images, ou déposez-les ici.</p>
        ) : (
          <ol className="pdfx-combine__list" aria-label="Fichiers à combiner">
            {items.map((it, i) => (
              <li
                key={it.id}
                className={`pdfx-combine__item ${dragged === it.id ? "is-dragged" : ""}`}
                draggable
                onDragStart={(e) => {
                  setDragged(it.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", it.name);
                }}
                onDragOver={(e) => {
                  if (!dragged) return;
                  e.preventDefault();
                  if (dragged !== it.id) move(dragged, i);
                }}
                onDragEnd={() => setDragged(null)}
                onDrop={(e) => {
                  if (!dragged) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDragged(null);
                }}
              >
                <span className="pdfx-combine__icon" aria-hidden>
                  {it.image ? <FileImage size={16} /> : <FileText size={16} />}
                </span>
                <span className="pdfx-combine__name" title={it.name}>
                  {it.id === "current" ? `${it.name} (document ouvert)` : it.name}
                </span>
                <span className="pdfx-combine__count">
                  {it.count === 0 ? "illisible" : it.image ? "image" : `${it.count} p.`}
                </span>
                {!it.image && !!it.count && (
                  <input
                    className="pdfx-combine__range"
                    aria-label={`Pages de ${it.name}`}
                    placeholder="toutes"
                    value={it.range}
                    onChange={(e) =>
                      setItems((list) => list.map((x) => (x.id === it.id ? { ...x, range: e.target.value } : x)))
                    }
                  />
                )}
                <span className="pdfx-combine__ops">
                  <button
                    className="pdfx-mini"
                    onClick={() => move(it.id, i - 1)}
                    disabled={i === 0}
                    title="Monter"
                    aria-label={`Monter ${it.name}`}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    className="pdfx-mini"
                    onClick={() => move(it.id, i + 1)}
                    disabled={i === items.length - 1}
                    title="Descendre"
                    aria-label={`Descendre ${it.name}`}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    className="pdfx-mini"
                    onClick={() => setItems((list) => list.filter((x) => x.id !== it.id))}
                    title="Retirer"
                    aria-label={`Retirer ${it.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </li>
            ))}
            {pending > 0 && (
              <li className="pdfx-combine__item is-pending">
                <Loader2 size={14} className="spin" /> Lecture de {pending} fichier{pending > 1 ? "s" : ""}…
              </li>
            )}
          </ol>
        )}
        <div className="pdfx-combine__bar">
          <button className="eb eb--outline eb--sm" onClick={() => input.current?.click()}>
            <Plus size={14} /> Ajouter des fichiers…
          </button>
          <label className="pdfx-check">
            <input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} />
            Un signet par fichier
          </label>
        </div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf,image/*"
          multiple
          hidden
          data-testid="combine-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void add(files);
          }}
        />
      </div>
    </Modal>
  );
}
