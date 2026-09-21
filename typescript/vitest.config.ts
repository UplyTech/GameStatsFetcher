import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/types.ts", "src/index.ts"],
      /**
       * Two tiers, on purpose. The glob-matched files are held to the higher
       * bar; the numbers above apply to everything else.
       *
       * The core - caching, rate limiting, transport, normalisation, the two
       * registries - is where a bug is a bug in every title at once, so it is
       * held to a high bar.
       *
       * The provider and title modules are mapping code: forty-odd near
       * identical translations from one JSON shape to another. They are covered
       * by a representative test per family plus the contract suite, which
       * walks every title and asserts it behaves the way its registry entry
       * says. Driving those files to 90 % would mean forty more fixtures whose
       * only real assertion is that the fixture was typed correctly - test
       * volume, not test value.
       */
      thresholds: {
        statements: 65,
        branches: 45,
        functions: 65,
        lines: 65,
        "src/{cache,constants,errors,http,identity,normalize,providers,rate-limiter,titles,title-client}.ts":
          {
            statements: 90,
            branches: 75,
            functions: 75,
            lines: 90,
          },
      },
    },
    testTimeout: 15000,
  },
});
