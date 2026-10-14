import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium } from "playwright-core";

/**
 * Runs `use` in a headless Google Chrome, or the Chrome or Chromium executable that `CHROME_PATH` names, and closes
 * the browser when it settles. `what` names what needs Chrome, for the error a failed launch throws.
 *
 * Chrome gets a folder of its own in the system temporary directory, holding its profile, Playwright's artifacts and
 * every file Chrome writes to `TMPDIR`. The folder is removed once the browser has closed, whether `use` succeeded or
 * not, and also when Chrome fails to launch.
 */
export async function withChrome<T>(what: string, use: (context: BrowserContext) => Promise<T>): Promise<T> {
  const executablePath = process.env.CHROME_PATH;
  // A short path: Chrome makes its SingletonSocket, a Unix socket, under TMPDIR, and a socket path has a length limit.
  const dir = await mkdtemp(join(tmpdir(), "chrome-"));
  try {
    const context = await chromium
      .launchPersistentContext(join(dir, "profile"), {
        ...(executablePath ? { executablePath } : { channel: "chrome" }),
        artifactsDir: dir,
        env: { ...process.env, TMPDIR: dir },
      })
      .catch((e: unknown) => {
        throw new Error(`${what} in Google Chrome: install it, or set CHROME_PATH to a Chrome or Chromium executable`, {
          cause: e,
        });
      });
    try {
      return await use(context);
    } finally {
      await context.close();
    }
  } finally {
    // When a launch fails, Chrome may go on writing to its profile while it closes: Playwright closes it, or kills
    // it after 30 seconds. The removal retries for 36 seconds in all (1 + 2 + ... + 8), longer than that.
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 1000 });
  }
}
