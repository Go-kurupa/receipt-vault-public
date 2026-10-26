import { configDefaults, defineConfig } from "vitest/config";

// functions/ のテストは functions 側の依存で動くため、ルートでは実行しない（cd functions && npm test で実行する）。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "functions/**", "mcp/**"],
  },
});
