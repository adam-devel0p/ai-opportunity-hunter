import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const dbPath = path.join(process.cwd(), "e2e", ".tmp", "e2e.db");
const port = 3412;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    // Fresh fixture DB per run (Phase 12, PLAN.md's Playwright acceptance criteria) — seeded with
    // a full pipeline scenario (`scripts/seedE2eFixture.ts`) rather than run through the real
    // (Claude-invoking) pipeline, since these tests exercise the dashboard UI, not agent behavior.
    command: `rm -f "${dbPath}"* && AOH_DB_PATH="${dbPath}" npx tsx scripts/seedE2eFixture.ts && AOH_DB_PATH="${dbPath}" npx next dev --webpack -p ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
