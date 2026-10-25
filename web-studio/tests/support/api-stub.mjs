/**
 * Faux serveur d'API pour les parcours navigateur SANS Drive : `/api/site/policy` répond « pas de site déployé »
 * (mode local), le reste 404. Sans lui, le proxy de Vite renvoie des 500 « Failed to load resource » qui
 * polluent la console et font échouer les tests qui exigent une console propre.
 * Usage : node tests/support/api-stub.mjs [port]  (défaut 8799)
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 8799);
http
  .createServer((req, res) => {
    const policy = (req.url || "").includes("/site/policy");
    res.writeHead(policy ? 200 : 404, { "content-type": "application/json" });
    res.end(policy ? '{"deployed":false}' : "{}");
  })
  .listen(port, "127.0.0.1");
