import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    /**
     * The server boundary, enforced rather than merely documented.
     *
     * `*.server.ts` holds the Atlas bearer, the private origin, and session sealing. Client
     * code reaching it would ship all of that to the browser. Only `*.server.ts` itself and
     * the `*.functions.ts` RPC wrappers — whose bodies the bundler replaces with a network
     * call — may import it. Tests run server-side and are exempt.
     *
     * The third exemption is a *server-only route file*: one whose sole `createFileRoute`
     * property is `server`. TanStack Start prunes such a subtree out of the client route tree
     * entirely and deletes the `server` node from the client build, so its imports never reach
     * the browser. ESLint cannot see that, so each such file is listed by name rather than
     * exempting `src/routes/api.*` wholesale — adding a `component` to one of these files must
     * stay a decision someone makes on purpose.
     */
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/**/*.server.ts",
      "src/**/*.functions.ts",
      "src/routes/api.artifacts.$id.content.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/*.server", "**/*.server.ts"],
              message:
                "Client code must not import `*.server.ts` — it carries the Atlas bearer and secrets. Go through a `*.functions.ts` server function instead.",
            },
          ],
        },
      ],
    },
  },
  {
    /**
     * `useSession` from `@tanstack/react-start/server` is TanStack Start's request-scoped
     * session primitive, not a React hook — the shared `use*` naming is all that makes the
     * rule fire. Server modules render nothing, so the rule cannot apply here.
     */
    files: ["src/**/*.server.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  eslintPluginPrettier,
);
