import { defineConfig } from "vitest/config";

export default defineConfig({
  // Ensure a single `graphql` instance across the test graph. graphql-ws and the
  // app code both depend on graphql, and without deduping vitest can load two
  // copies, which trips graphql's "Duplicate graphql modules" instanceof guard.
  resolve: {
    dedupe: ["graphql"],
  },
  test: {
    globals: true,
    environment: "node",
    server: {
      deps: {
        inline: ["graphql-ws"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
