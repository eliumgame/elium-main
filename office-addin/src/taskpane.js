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
    // GARDE-FOU: le chiffrement n'est pas implémenté dans ce prototype.
    // On échoue immédiatement, avant toute lecture du document, pour ne
    // jamais laisser croire à un traitement (même partiel) du contenu.
    const status = document.getElementById("status");
    status.style.color = "#c0392b";
    status.style.fontWeight = "bold";
    status.innerText =
        "❌ Chiffrement NON implémenté — ce prototype ne protège aucune donnée. " +
        "N'utilisez pas ce bouton en production.";
    return;
}
