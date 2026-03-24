import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"@hirocode/agent-core": path.resolve(root, "../agent/src/index.ts"),
			"@hirocode/ai/oauth": path.resolve(root, "../ai/src/oauth.ts"),
			"@hirocode/ai": path.resolve(root, "../ai/src/index.ts"),
			"@hirocode/tui": path.resolve(root, "../tui/src/index.ts"),
		},
	},
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    server: {
      deps: {
        external: [/@silvia-odwyer\/photon-node/],
      },
    },
  },
});
