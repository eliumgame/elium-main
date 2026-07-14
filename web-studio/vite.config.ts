/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
  },
  build: {
    target: 'esnext'
  },
  test: {
    // Les tests crypto enchaînent plusieurs dérivations Argon2id (256 MiB,
    // ~1,3 s chacune) : le délai par défaut de 5 s peut être dépassé sur une
    // machine chargée. On laisse une marge confortable.
    testTimeout: 30000,
  },
});
