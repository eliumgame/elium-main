/**
 * Elium Office Add-in — Taskpane Logic
 *
 * ⚠ PROTOTYPE: Real encryption is NOT implemented.
 * This module extracts document text and logs it for demonstration purposes only.
 *
 * TODO:
 * - Integrate Elium crypto engine (via WebAssembly or API call)
 * - Implement actual file download of .elium container
 * - Add decryption support
 */

Office.onReady((info) => {
    if (info.host === Office.HostType.Word) {
        document.getElementById("btn-encrypt").onclick = encryptDocument;
    } else {
        document.getElementById("status").innerText = "⚠ Cette extension ne supporte que Microsoft Word.";
        document.getElementById("btn-encrypt").disabled = true;
    }
});

async function encryptDocument() {
    try {
        const password = document.getElementById("txt-password").value;
        if (!password) {
            throw new Error("Veuillez entrer un mot de passe.");
        }

        document.getElementById("status").innerText = "Extraction du contenu...";
        document.getElementById("btn-encrypt").disabled = true;

        await Word.run(async (context) => {
            const body = context.document.body;
            body.load("text");
            await context.sync();

            const textLength = body.text.length;

            // PROTOTYPE: Log extraction results but don't actually encrypt
            console.log("[Elium Prototype] Extraction réussie.");
            console.log("[Elium Prototype] Longueur du texte:", textLength, "caractères.");
            console.log("[Elium Prototype] Mot de passe fourni:", "*".repeat(password.length));

            document.getElementById("status").innerText =
                `⚠ Prototype: ${textLength} caractères extraits. ` +
                `Le chiffrement réel n'est pas encore implémenté.`;
        });
    } catch (error) {
        console.error("[Elium]", error);
        document.getElementById("status").innerText = "Erreur : " + error.message;
    } finally {
        document.getElementById("btn-encrypt").disabled = false;
    }
}
