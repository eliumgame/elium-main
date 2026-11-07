import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Plusieurs tests bootent la vraie app (helmet/cors/rate-limit/ws) ou
    // enchaînent des opérations coûteuses (parsing d'un body de 1 MiB, dérivations
    // Argon2id) ; en suite complète, la contention CPU des workers parallèles peut
    // faire dépasser le délai par défaut de 5 s. Marge confortable pour éviter les
    // faux échecs par timeout, sans masquer de vraie lenteur.
    testTimeout: 30000,
  },
});
