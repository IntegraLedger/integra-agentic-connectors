import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium } from "playwright-core";
import { browserExecutable } from "../../scripts/browser.mjs";

/** What a caller adds to the browser's launch: variables in its environment, and the page's time zone and locale. */
export interface ChromeSetup {
  env?: Record<string, string>;
  timezoneId?: string;
  locale?: string;
}

/**
 * Runs `use` in the headless browser build the repository pins and fetches by its SHA-256 (`scripts/browser.mjs`), and
 * closes the browser when it settles. Without that build, it throws before the launch, naming the command that fetches
 * it.
 *
 * The browser gets a folder of its own in the system temporary directory, holding its profile, Playwright's artifacts
 * and every file the browser writes to `TMPDIR` or `HOME`. Its environment holds that folder as `HOME` and `TMPDIR`,
 * and only what `setup` adds: `setup`, when given, is called with the folder before the launch, may write files there,
 * and gives the variables and options it adds. With no `setup`, the browser reads the machine's font configuration,
 * and so the machine's fonts. Chrome Headless Shell opens no Unix socket in the folder, so its path may be any length.
 * The folder is removed once the browser has closed, whether `use` succeeded or not, and also when the browser fails
 * to launch.
 */
export async function withChrome<T>(
  use: (context: BrowserContext) => Promise<T>,
  setup?: (dir: string) => Promise<ChromeSetup>,
): Promise<T> {
  const executablePath = browserExecutable();
  const dir = await mkdtemp(join(tmpdir(), "chrome-"));
  try {
    const { env, ...options } = (await setup?.(dir)) ?? {};
    const context = await chromium.launchPersistentContext(join(dir, "profile"), {
      executablePath,
      headless: true,
      artifactsDir: dir,
      env: { HOME: dir, TMPDIR: dir, ...env },
      ...options,
    });
    try {
      return await use(context);
    } finally {
      await context.close();
    }
  } finally {
    // When a launch fails, the browser may go on writing to its profile while it closes: Playwright closes it, or kills
    // it after 30 seconds. The removal retries for 36 seconds in all (1 + 2 + ... + 8), longer than that.
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 1000 });
  }
}
