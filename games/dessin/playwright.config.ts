import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/e2e",
  workers: 1,
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:4415",
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command: "node --import tsx scripts/test-server.ts",
    url: "http://127.0.0.1:4415/dessin/api/health",
    timeout: 60000,
  },
});
