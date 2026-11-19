import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      nstructjs: path.resolve(import.meta.dirname, "extern/nstructjs/build/nstructjs_es6.js"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
