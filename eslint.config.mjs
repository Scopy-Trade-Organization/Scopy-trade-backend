import tsParser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "constructor-super": "error",
      "no-constant-binary-expression": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "valid-typeof": "error",
    },
  },
];
