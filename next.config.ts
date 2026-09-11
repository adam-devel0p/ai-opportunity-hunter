import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This is a local-only, single-operator dashboard reading/writing SQLite directly from server
  // components and server actions (PLAN.md §14, ADR-0003) — no image optimization, no rewrites,
  // no external API surface to configure.
  //
  // `better-sqlite3` ships a native `.node` binding (same one src/db/client.ts already relies on)
  // — it must stay a real `require()` at runtime rather than get bundled by Next's server
  // compiler, which doesn't understand native addons.
  serverExternalPackages: ["better-sqlite3"],
  // `src/lib`/`src/db`/`src/pipeline` are shared with the backend (worker/scripts), which compiles
  // under `moduleResolution: "NodeNext"` — that mode requires relative imports to spell out the
  // literal ".js" extension of their *emitted* file, even though the source is ".ts" (see
  // tsconfig.backend.json). Next's own bundler doesn't do that remapping by default, so importing
  // any shared module from `src/app` fails to resolve without this alias.
  experimental: {
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
};

export default nextConfig;
