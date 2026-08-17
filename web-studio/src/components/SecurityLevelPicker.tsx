import { useState } from "react";
import { ShieldOff, ShieldCheck, ShieldHalf, ChevronDown, ChevronUp } from "lucide-react";
import { Modal } from "../ui/components";
import { PROFILE_ORDER, PROFILES } from "../format/profiles";
import type { EliumProfile } from "../format/types";

/**
 * Trois choix simples avant la première sauvegarde, pour qu'un nouveau
 * document ne reste pas non chiffré sans que ce soit un choix conscient
 * (le profil par défaut — "standard" — n'est pas chiffré). Le mot de passe
 * lui-même n'est PAS demandé ici : il l'est déjà automatiquement à
 * l'enregistrement dès que le profil actif l'exige (voir SecurityPanel /
 * studio.changeProfile) — cet écran ne fait que choisir le profil de départ.
 */

const QUICK_LEVELS: {
  id: EliumProfile;
  icon: React.ReactNode;
  label: string;
  blurb: string;
}[] = [
  {
    id: "standard",
    icon: <ShieldOff size={22} />,
    label: "Simple",
    blurb: "Non chiffré : lisible par quiconque ouvre le fichier. Rapide pour un brouillon ou un contenu non sensible.",
  },
  {
    id: "encrypted",
    icon: <ShieldCheck size={22} />,
    label: "Confidentiel",
    blurb: "Chiffré (AES-256-GCM) avec un mot de passe demandé à l'enregistrement. Illisible sans lui.",
  },
  {
    id: "secure_max",
    icon: <ShieldHalf size={22} />,
    label: "Ultra sécurisé",
    blurb: "Chiffrement + verrouillage + signature (et clé de fichier en option). Pour un document final sensible.",
  },
];

export default function SecurityLevelPicker({
  onChoose,
  onCancel,
}: {
  onChoose: (profile: EliumProfile) => void;
  onCancel: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);

  return (
    <Modal title="Comment protéger ce document ?" onClose={onCancel} wide>
      <p className="muted">
        Ce choix ne bloque rien : vous pourrez toujours changer de profil plus tard dans le panneau Sécurité.
      </p>

      {!advanced ? (
        <div className="profile-grid profile-grid--quick">
          {QUICK_LEVELS.map((lvl) => {
            const p = PROFILES[lvl.id];
            return (
              <button
                key={lvl.id}
                className="profile-card profile-card--quick"
                autoFocus={lvl.id === "standard"}
                onClick={() => onChoose(lvl.id)}
              >
                <div className="profile-card__head">
                  {lvl.icon}
                  <span className={`badge badge--${p.accent}`}>{p.badge}</span>
                </div>
                <div className="profile-card__label">{lvl.label}</div>
                <div className="profile-card__desc">{lvl.blurb}</div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="profile-grid">
          {PROFILE_ORDER.map((id) => {
            const p = PROFILES[id];
            return (
              <button key={id} className="profile-card" onClick={() => onChoose(id)}>
                <div className="profile-card__head">
                  <span className={`badge badge--${p.accent}`}>{p.badge}</span>
                </div>
                <div className="profile-card__label">{p.label}</div>
                <div className="profile-card__desc">{p.description}</div>
                <div className="profile-card__caps">
                  {p.encrypted && <span>🔒 chiffré</span>}
                  {p.passwordRequired && <span>🔑 mot de passe</span>}
                  {p.locked && <span>📌 verrouillé</span>}
                  {p.tracking && <span>🧾 suivi</span>}
                  {p.signaturesExpected && <span>✍ signature</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <button type="button" className="link-toggle" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {advanced ? "Revenir aux 3 choix simples" : "Voir les 7 profils avancés"}
      </button>
    </Modal>
  );
}
