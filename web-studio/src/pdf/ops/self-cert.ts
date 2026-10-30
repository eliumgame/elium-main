/**
 * Certificat X.509 AUTO-SIGNÉ généré dans l'app, empaqueté en PKCS#12, pour
 * signer un PDF en PAdES (voir pades.ts) sans que l'utilisateur ait à fournir
 * son propre certificat.
 *
 * Adobe le reconnaîtra comme une VRAIE signature (dictionnaire /Sig + CMS), mais
 * affichera « identité non vérifiée » : un certificat auto-signé n'a pas
 * d'autorité de certification. Pour une coche verte « approuvé », l'utilisateur
 * importe son propre .p12 (flux séparé). C'est le compromis « zéro friction ».
 */
import forge from "node-forge";

function binToU8(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}

type RsaKeyPair = ReturnType<typeof forge.pki.rsa.generateKeyPair>;

/** Certificat auto-signé + PKCS#12 à partir d'une paire de clés RSA déjà générée. */
function buildP12(keys: RsaKeyPair, commonName: string, password: string): Uint8Array {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Numéro de série aléatoire positif (préfixe 00 pour éviter un bit de signe).
  cert.serialNumber = "00" + forge.util.bytesToHex(forge.random.getBytesSync(8));
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 24 * 3600 * 1000); // -1 j (tolérance d'horloge)
  cert.validity.notAfter = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate());
  const attrs = [
    { name: "commonName", value: commonName || "Signature Elium (auto-signée)" },
    { name: "organizationName", value: "Elium" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // auto-signé : émetteur = sujet
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "extKeyUsage", clientAuth: true, emailProtection: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  // 3DES VOLONTAIREMENT conservé : c'est l'algorithme PKCS#12 que Windows (certmgr),
  // Adobe Acrobat et les anciens OpenSSL relisent partout. AES-256 (PBES2) est mal
  // ou pas lu par plusieurs d'entre eux ; ne pas le changer sans test sur ces cibles.
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return binToU8(forge.asn1.toDer(p12Asn1).getBytes());
}

/**
 * Génère un certificat auto-signé RSA-2048 (CN = `commonName`) valable ~10 ans
 * et renvoie un PKCS#12 (DER) protégé par `password`, directement consommable
 * par signPdfBytes. La génération de clé RSA est synchrone (~1–3 s) et BLOQUE le
 * thread UI : préférer generateSelfSignedP12Async dans l'interface.
 */
export function generateSelfSignedP12(commonName: string, password: string): Uint8Array {
  return buildP12(forge.pki.rsa.generateKeyPair(2048), commonName, password);
}

/**
 * Même résultat, mais la génération de clé est découpée en tranches (workers: 0 =
 * pas de Web Worker, donc compatible CSP) qui rendent la main au thread UI entre
 * deux tranches : l'indicateur d'occupation de l'appelant reste animé.
 */
export function generateSelfSignedP12Async(commonName: string, password: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 }, (err, keys) => {
      if (err || !keys) {
        reject(err ?? new Error("Échec de génération de la clé RSA"));
        return;
      }
      try {
        resolve(buildP12(keys, commonName, password));
      } catch (e) {
        reject(e);
      }
    });
  });
}
