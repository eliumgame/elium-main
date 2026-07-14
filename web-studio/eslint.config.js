// ESLint 9 flat config — web-studio (Vite/React/TS).
// Formatting is Prettier's job (see .prettierrc); ESLint only enforces
// correctness/hooks rules. `eslint-config-prettier` disables any stylistic
// rules that would fight Prettier.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "*.config.js", "*.config.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The codebase deliberately uses a few `any`/`@ts-ignore` at crypto/DOM
      // boundaries; keep those pragmatic and let tsc be the type gate.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Binary/PDF text handling legitimately matches control chars and
      // normalizes non-breaking spaces inside regexes.
      "no-control-regex": "off",
      "no-irregular-whitespace": ["error", { skipRegExps: true, skipStrings: true, skipTemplates: true }],
    },
  },
  prettier, // must stay last: turns off rules that conflict with Prettier
);
