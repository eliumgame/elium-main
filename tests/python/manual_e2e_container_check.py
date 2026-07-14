import os

from elium.core.container import EliumContainer
from elium.crypto.primitives import generate_ed25519_keypair


def main():
    print("=== DÉBUT DU TEST DE BOUT EN BOUT (E2E) ===")

    payload = b"Ceci est un message hautement confidentiel teste de A a Z."
    password = "SuperSecretPassword123!"

    print("\n1. Génération de l'identité Ed25519...")
    priv_key, pub_key = generate_ed25519_keypair()
    print("   [OK] Clés générées.")

    print("\n2. Création du conteneur sécurisé (Cascade + Signature)...")
    encoded = EliumContainer.encode(
        payload=payload,
        password=password,
        manifest_meta={"files": [{"name": "secret.txt", "size": len(payload)}]},
        compress=True,
        cascade=True,
        signing_key=priv_key
    )

    with open("test_e2e.elium", "wb") as f:
        f.write(encoded)

    size = os.path.getsize("test_e2e.elium")
    print(f"   [OK] Fichier 'test_e2e.elium' créé ({size} octets).")

    print("\n3. Ouverture et Déchiffrement du conteneur...")
    with open("test_e2e.elium", "rb") as f:
        blob = f.read()

    dec_payload, manifest, header = EliumContainer.decode(
        blob=blob,
        password=password,
        verify_public_key=pub_key
    )
    print("   [OK] Déchiffrement réussi !")

    print("\n4. Vérification des garanties de sécurité :")
    print(f"   - Contenu déchiffré : {dec_payload.decode('utf-8')}")
    print(f"   - Manifeste : {manifest}")
    print(f"   - Version du format : v{header.get('version')}")
    print(f"   - Cascade active : {header['crypto'].get('cascade') == 'chacha20-poly1305'}")
    print(f"   - Validité Signature : {header.get('signature_valid')}")

    assert dec_payload == payload, "Erreur de corruption du payload"
    assert header.get('signature_valid') is True, "Signature invalide"

    print("\n=== SUCCÈS : TOUS LES MÉCANISMES FONCTIONNENT PARFAITEMENT ===")

if __name__ == "__main__":
    main()
