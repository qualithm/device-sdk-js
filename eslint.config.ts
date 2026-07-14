import { defineConfig } from "eslint/config"

import baseConfig from "./eslint.base.config"

export default defineConfig([
  { ignores: ["dist", "docs", "coverage"] },
  ...baseConfig,
  // The CLI's entire job is stdout/stderr output.
  { files: ["src/bin/**/*.ts", "src/cli/**/*.ts"], rules: { "no-console": "off" } }
])
