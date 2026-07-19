import { defineConfig, devices } from "@playwright/test";

const defaultBaseURL = "http://127.0.0.1:4173";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? defaultBaseURL;
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1";
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_WEBSERVER === "1";

if (!skipWebServer && baseURL !== defaultBaseURL) {
  throw new Error(
    "Set PLAYWRIGHT_SKIP_WEBSERVER=1 when PLAYWRIGHT_BASE_URL targets an external server.",
  );
}

export default defineConfig({
  testDir: "./tests/launch",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: skipWebServer
    ? undefined
    : {
        command: "bun run preview:test",
        url: `${baseURL}/build-info.json`,
        reuseExistingServer,
        timeout: 120_000,
      },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
