/** The orchestration contract shared by every view and panel. */
import type {
  EliumFile,
  EliumProfile,
  EliumSignature,
  ProseMirrorNode,
  SignatureVerdict,
  PageSettings,
  EliumDocStyle,
  EliumWatermark,
} from "../format/types";
import type { IntegrityVerdict } from "../format/elium-package";
import type { JournalVerdict } from "../format/journal";
import type { EliumIdentity } from "../sign/keys";
import type { SealVerdict } from "../sign/seal";
import type { SealPinCheck } from "../sign/seal-pinning";
import type { TrustedContact } from "../sign/trust-book";
import type { RecipientPublic } from "../crypto/recipient-key-store";
import type { SignatureDraft } from "../sign/SignatureCreator";
import type { VaultSecret } from "../crypto/local-vault";

export type StudioMode = "home" | "studio" | "viewer" | "sheet" | "slides" | "pdf" | "drive-cloud" | "documentation";
export type ExportKind = "html" | "md" | "text" | "pdf" | "report" | "docx";
export type PanelId = "signatures" | "parapheur" | "comments" | "security" | "tracking" | "versions" | "export" | "info";

export interface Studio {
  file: EliumFile;
  editable: boolean;
  identity: EliumIdentity | null;
  /** Carnet local de clés de confiance (name→clé). */
  trustBook: TrustedContact[];
  /** sigId → nom du contact attribué (clé de la preuve reconnue au carnet). */
  attributions: Record<string, string>;
  /** Nom du scelleur si sa clé figure au carnet, sinon null. */
  sealAttribution: string | null;
  verdicts: Record<string, SignatureVerdict>;
  integrity: IntegrityVerdict | null;
  journalVerdict: JournalVerdict | null;
  sealVerdict: SealVerdict | null;
  sealPin: SealPinCheck | null;
  selectedSig: string | null;
  busy: boolean;
  versionSecret?: VaultSecret; // document password and/or keyfile — encrypts local version snapshots at rest
  vaultSecret?: VaultSecret; // app-wide local vault password (opt-in) — encrypts the Parapheur circuit at rest
  recipients: string[]; // P-256 public keys (hex) this doc will be encrypted FOR on save
  recipientPublic: RecipientPublic | null; // this user's own recipient key (to receive)

  setTitle(title: string): void;
  /** Approuver une clé (de sceau ou de preuve) sous un nom dans le carnet. */
  trustContact(name: string, publicKeyHex: string): Promise<void>;
  /** Retirer une clé du carnet. */
  untrustContact(publicKeyHex: string): void;
  generateIdentity(): Promise<void>;
  changeProfile(profile: EliumProfile): Promise<void>;
  setAccessExpiry(iso: string | null): void;
  setEncryptMetadata(on: boolean): void;
  setRecipients(publicHexes: string[]): void;
  generateRecipientKey(): Promise<void>;
  forgetRecipientKey(): void;
  updatePage(patch: Partial<PageSettings>): void;
  /** Replace the document's own named styles. */
  updateStyles(styles: EliumDocStyle[]): void;
  /** Le filigrane appartient au document entier, pas à un nœud. */
  updateWatermark(mark: EliumWatermark): void;
  openSignatureCreator(): void;
  createSignature(draft: SignatureDraft): Promise<void>;
  updateSignature(sig: EliumSignature): void;
  removeSignature(id: string): void;
  selectSignature(id: string | null): void;
  onDocChange(doc: ProseMirrorNode): void;
  save(): Promise<void>;
  exportAs(kind: ExportKind): Promise<void>;
  goHome(): void;
  toViewer(): void;
  toEditor(): void;
  trustSealKey(): void;
  openSettings(): void;
}
