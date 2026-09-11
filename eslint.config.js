// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", ".next/**", "playwright-report/**", "test-results/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Dashboard (Phase 12): JSX parsing + React's hook rules, scoped to src/app since nothing
  // outside it uses React. Full `eslint-plugin-react` is skipped for now — it doesn't yet
  // declare a peer range covering ESLint 10 (see docs/DECISIONS.md ADR-0019), and
  // typescript-eslint + react-hooks already catch the errors that matter most in a mostly
  // server-component codebase with React 19's automatic JSX runtime (no `import React` to flag).
  {
    files: ["src/app/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
