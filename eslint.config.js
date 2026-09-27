import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

const NODE_FILES = [
  "eslint.config.js",
  "vite.config.ts",
  "shopify.server.ts",
  "**/*.server.ts",
];

export default tseslint.config(
  {
    ignores: [
      "build/**",
      ".react-router/**",
      "node_modules/**",
      "public/build/**",
      ".shopify/**",
    ],
  },
  js.configs.recommended,
  // eslint-disable-next-line import/no-named-as-default-member -- documented usage, see typescript-eslint.io/getting-started
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        shopify: "readonly",
      },
    },
    settings: {
      react: { version: "detect" },
      "import/internal-regex": "^~/",
      "import/resolver": {
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      "react/no-unknown-property": ["error", { ignore: ["variant"] }],
      "import/no-unresolved": "off",
    },
  },
  {
    files: NODE_FILES,
    languageOptions: {
      globals: globals.node,
    },
  },
);
