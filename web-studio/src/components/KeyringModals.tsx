import { useMemo, useRef, useState } from "react";
import { strToU8 } from "fflate";
import { Eye, EyeOff, Download } from "lucide-react";
import { Modal, Button, Alert, Field, Tabs } from "../ui/components";
import { useKeyringController } from "../crypto/use-keyring";
import { makePhraseChallenge, checkPhraseChallenge, normalizePhrase } from "../crypto/recovery-phrase";
import { parseShare, shareFileName, MAX_SHARES, type Share } from "../crypto/shamir";
import { downloadBlob } from "../export/exporters";
import { reportError } from "../ui/crash-log";

/** Phrase de 24 mots : avertissement → affichage → vérification de la saisie. */
export function RecoveryPhraseModal({ onClose }: { onClose: () => void }) {
  const k = useKeyringController();
  const [phrase, setPhrase] = useState<string | null>(null);
  const [shown, setShown] = useState(true);
  const [stage, setStage] = useState<"intro" | "show" | "verify" | "done">("intro");
  const challenge = useMemo(() => makePhraseChallenge(4), []);
  const [answers, setAnswers] = useState<string[]>(["", "", "", ""]);
  const [wrong, setWrong] = useState(false);

  const reveal = async () => {
    const p = await k.getRecoveryPhrase();
    if (p) {
      setPhrase(p);
      setStage("show");
    }
  };

  const verify = async () => {
    if (!phrase) return;
    if (checkPhraseChallenge(phrase, challenge, answers)) {
      await k.markPhraseVerified();
      setStage("done");
    } else setWrong(true);
  };

  const close = () => {
    setPhrase(null); // la phrase ne reste pas en mémoire d'interface
    onClose();
  };

  return (
    <Modal
      title="Phrase de récupération"
      onClose={close}
      footer={
        stage === "intro" ? (
          <>
            <Button variant="ghost" onClick={close}>
              Annuler
            </Button>
            <Button onClick={() => void reveal()}>Afficher les 24 mots</Button>
          </>
        ) : stage === "show" ? (
          <Button onClick={() => setStage("verify")}>Je l'ai notée — vérifier</Button>
        ) : stage === "verify" ? (
          <>
            <Button variant="ghost" onClick={() => setStage("show")}>
              Revoir la phrase
            </Button>
            <Button disabled={answers.some((a) => !a.trim())} onClick={() => void verify()}>
              Vérifier
            </Button>
          </>
        ) : (
          <Button onClick={close}>Terminer</Button>
        )
      }
    >
      {stage === "intro" && (
        <div className="settings">
          <Alert tone="warning" title="Une phrase = toutes vos clés">
            Ces 24 mots permettent de recréer votre identité de signature et votre clé de réception sur n'importe quel
            appareil. Quiconque les lit peut se faire passer pour vous : notez-les sur papier, hors de tout écran
            partagé, et ne les photographiez pas. Elles ne couvrent pas les clés importées (non dérivées) : gardez aussi
            votre fichier .eliumkey.
          </Alert>
        </div>
      )}
      {stage === "show" && phrase && (
        <div className="settings">
          <div className="keyring__phrase" aria-live="polite">
            {phrase.split(" ").map((w, i) => (
              <span key={i} className="keyring__word">
                <span className="keyring__wordn">{i + 1}</span>
                {shown ? w : "••••••"}
              </span>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShown((s) => !s)}>
            {shown ? <EyeOff size={14} /> : <Eye size={14} />} {shown ? "Masquer" : "Afficher"}
          </Button>
        </div>
      )}
      {stage === "verify" && (
        <div className="settings">
          <p className="muted">Pour vérifier que votre notation est lisible, saisissez les mots demandés.</p>
          {challenge.positions.map((pos, i) => (
            <Field key={pos} label={`Mot n° ${pos}`}>
              <input
                className="settings__input"
                value={answers[i]}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => {
                  const a = [...answers];
                  a[i] = e.target.value;
                  setAnswers(a);
                  setWrong(false);
                }}
              />
            </Field>
          ))}
          {wrong && (
            <Alert tone="danger" title="Un ou plusieurs mots ne correspondent pas">
              Relisez votre notation (ou revoyez la phrase) puis réessayez.
            </Alert>
          )}
        </div>
      )}
      {stage === "done" && (
        <Alert tone="success" title="Phrase vérifiée">
          Votre phrase de récupération est correctement notée. Conservez-la en lieu sûr.
        </Alert>
      )}
    </Modal>
  );
}

/** Partage de Shamir k-parmi-n : génère et exporte des fichiers .eliumshare. */
export function SharesModal({ onClose }: { onClose: () => void }) {
  const k = useKeyringController();
  const [kk, setKk] = useState(2);
  const [nn, setNn] = useState(3);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [downloaded, setDownloaded] = useState<Set<number>>(new Set());

  const valid = kk >= 2 && kk <= nn && nn <= MAX_SHARES;

  const generate = async () => {
    const s = await k.splitMasterShares(kk, nn);
    if (s) setShares(s);
  };
  const download = (s: Share) => {
    downloadBlob(shareFileName(s), "application/json", strToU8(JSON.stringify(s, null, 2)));
    setDownloaded((d) => new Set(d).add(s.x));
  };
  const finish = async () => {
    await k.markSharesExported();
    setShares(null);
    onClose();
  };

  return (
    <Modal
      title="Parts de récupération (Shamir)"
      onClose={() => {
        setShares(null);
        onClose();
      }}
      footer={
        shares ? (
          <Button disabled={downloaded.size < shares.length} onClick={() => void finish()}>
            J'ai distribué toutes les parts
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button disabled={!valid} onClick={() => void generate()}>
              Générer les parts
            </Button>
          </>
        )
      }
    >
      <div className="settings">
        {!shares ? (
          <>
            <Alert tone="info" title="Répartir la confiance">
              Le secret maître du trousseau est découpé en <b>n</b> parts : il en faut <b>k</b> pour le reconstituer, et
              k-1 parts n'apprennent strictement rien. Confiez chaque part (.eliumshare) à une personne ou un support
              différent (coffre, proche, clé USB).
            </Alert>
            <Field label="Parts nécessaires (k)">
              <input
                className="settings__input"
                type="number"
                min={2}
                max={nn}
                value={kk}
                onChange={(e) => setKk(Number(e.target.value))}
              />
            </Field>
            <Field label={`Parts à créer (n, maximum ${MAX_SHARES})`}>
              <input
                className="settings__input"
                type="number"
                min={kk}
                max={MAX_SHARES}
                value={nn}
                onChange={(e) => setNn(Number(e.target.value))}
              />
            </Field>
            {!valid && <p className="muted">Il faut 2 ≤ k ≤ n ≤ {MAX_SHARES}.</p>}
          </>
        ) : (
          <>
            <Alert tone="warning" title="Téléchargez et distribuez chaque part">
              Ces parts ne seront plus affichées. {kk} sur {nn} suffisent à restaurer le trousseau.
            </Alert>
            <ul className="keyring__passkeys">
              {shares.map((s) => (
                <li key={s.x}>
                  <span>
                    Part {s.x} / {s.n} {downloaded.has(s.x) && <span className="muted">— téléchargée</span>}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => download(s)}>
                    <Download size={13} /> Télécharger
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Restauration : phrase de 24 mots, parts Shamir, ou fichier .eliumkey. */
export function RestoreModal({ onClose }: { onClose: () => void }) {
  const k = useKeyringController();
  const [tab, setTab] = useState<"phrase" | "shares" | "file">("phrase");
  const [phrase, setPhrase] = useState("");
  const [shares, setShares] = useState<Share[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const shareRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const words = normalizePhrase(phrase).length;

  const addShares = async (files: FileList | null) => {
    if (!files) return;
    setErr(null);
    const next = [...shares];
    for (const f of Array.from(files)) {
      try {
        const s = parseShare(await f.text());
        if (!next.some((x) => x.x === s.x && x.setId === s.setId)) next.push(s);
      } catch (e) {
        reportError("keyring.parseShare", e);
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
    setShares(next);
  };

  return (
    <Modal
      title="Restaurer le trousseau"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      }
    >
      <div className="settings">
        <Tabs
          tabs={[
            { id: "phrase", label: "Phrase" },
            { id: "shares", label: "Parts" },
            { id: "file", label: "Fichier .eliumkey" },
          ]}
          active={tab}
          onChange={(id) => {
            setTab(id as typeof tab);
            setErr(null);
          }}
        />
        {tab === "phrase" && (
          <>
            <Field label={`Phrase de 24 mots (${words}/24)`}>
              <textarea
                className="settings__input"
                rows={4}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
              />
            </Field>
            <Button
              disabled={words !== 24}
              onClick={async () => {
                if (await k.restoreFromPhrase(phrase)) {
                  setPhrase("");
                  onClose();
                }
              }}
            >
              Restaurer depuis la phrase
            </Button>
            <p className="muted">
              Les clés dérivées sont recréées (les premiers indices). Un nouveau mot de passe vous sera demandé.
            </p>
          </>
        )}
        {tab === "shares" && (
          <>
            <p className="muted">Ajoutez au moins le nombre de parts (.eliumshare) requis par le partage.</p>
            <Button variant="outline" size="sm" onClick={() => shareRef.current?.click()}>
              Ajouter des parts…
            </Button>
            <input
              ref={shareRef}
              type="file"
              accept=".eliumshare,application/json"
              multiple
              hidden
              onChange={(e) => void addShares(e.target.files)}
            />
            {shares.length > 0 && (
              <p>
                {shares.length} part(s) chargée(s) — {shares[0].k} requise(s).
              </p>
            )}
            <Button
              disabled={shares.length === 0 || shares.length < shares[0].k}
              onClick={async () => {
                if (await k.restoreFromShares(shares)) {
                  setShares([]);
                  onClose();
                }
              }}
            >
              Restaurer depuis les parts
            </Button>
          </>
        )}
        {tab === "file" && (
          <>
            <p className="muted">Importez une sauvegarde .eliumkey (v1 identité seule, ou v2 trousseau complet).</p>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              Choisir un fichier…
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".eliumkey,application/json"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f && (await k.importBackupText(await f.text()))) onClose();
              }}
            />
          </>
        )}
        {err && (
          <Alert tone="danger" title="Erreur">
            {err}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
