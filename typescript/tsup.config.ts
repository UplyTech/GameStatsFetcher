import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "node20",
  platform: "node",
  // Caching is optional. Bundling ioredis would make it mandatory.
  external: ["ioredis"],
  minify: false,
});
