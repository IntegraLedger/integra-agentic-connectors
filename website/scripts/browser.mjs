// The browser that draws the site's Mermaid diagrams at build time (src/mdx/mermaid.ts) and loads its pages in
// scripts/check-pages.mjs, both through src/lib/chrome.ts: Chrome Headless Shell 156.0.8078.4 for Linux x64, the build
// the locked playwright-core names for `chromium-headless-shell` in its browsers.json, as Chrome for Testing publishes
// it. The site uses this one build on every machine, never a browser the machine has, so one commit draws one set of
// diagrams.
//
// Run in website/ (`pnpm run browser`), this module fetches the archive, retrying a failed download five times,
// checks it against the SHA-256 below, and unpacks it into website/.browser/, with the SHA-256 it checked.
// `browserExecutable()` gives the build the executable, and refuses when the folder holds anything else.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

export const BROWSER = {
  name: "Chrome Headless Shell",
  version: "156.0.8078.4",
  /** The one platform it is pinned for, as `${process.platform}-${process.arch}` names it. */
  platform: "linux-x64",
  url: "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.4/linux64/chrome-headless-shell-linux64.zip",
  /** The archive's SHA-256. Its MD5 equals the one the storage bucket gives for the object (`x-goog-hash`). */
  sha256: "c3e50596aef52c58f8fda3c6b3411c33d34c88b177b3ed1c2243359fd3b8ba20",
  /** The executable, inside the archive. */
  executable: "chrome-headless-shell-linux64/chrome-headless-shell",
};

/** The folder the archive is unpacked into, in website/, where the build and this module run. */
const folder = () => resolve(process.cwd(), ".browser");
/** The file in that folder that holds the SHA-256 of the archive unpacked there. */
const DIGEST_FILE = "archive.sha256";
const FETCH = "run `pnpm run browser` in website/ to fetch it";
/**
 * The attempts at the download: a network error or an answer other than 2xx starts the next, after 1, 2, 4, 8 and
 * 16 s.
 */
const ATTEMPTS = 6;

/**
 * The executable of the pinned build, in website/.browser/. Throws, naming the command that fetches the build, when
 * this machine is not the build's platform, when the locked playwright-core names another build, or when the folder
 * does not hold the build unpacked from the archive with the SHA-256 above.
 */
export function browserExecutable() {
  const what = `${BROWSER.name} ${BROWSER.version} (${BROWSER.platform})`;
  const here = `${process.platform}-${process.arch}`;
  if (here !== BROWSER.platform) {
    throw new Error(
      `The site's diagrams are drawn and its pages checked in ${what}, which does not run on ${here}: build the site on ${BROWSER.platform}`,
    );
  }
  const named = playwrightBuild();
  if (named !== BROWSER.version) {
    throw new Error(
      `playwright-core names ${BROWSER.name} ${named}, and website/scripts/browser.mjs pins ${BROWSER.version}: pin the build it names, with that archive's SHA-256`,
    );
  }
  const dir = folder();
  const unpacked = readDigest(dir);
  if (unpacked !== BROWSER.sha256) {
    const held = unpacked === undefined ? "does not hold it" : `holds an archive with SHA-256 ${unpacked}`;
    throw new Error(`The site's diagrams are drawn and its pages checked in ${what}, and ${dir} ${held}: ${FETCH}`);
  }
  const executable = join(dir, BROWSER.executable);
  if (!existsSync(executable)) throw new Error(`${executable} is missing: ${FETCH} again`);
  return executable;
}

/** The SHA-256 of the archive unpacked into the folder, if one is. */
function readDigest(dir) {
  const file = join(dir, DIGEST_FILE);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

/** The `chromium-headless-shell` build the locked playwright-core names in its browsers.json. */
function playwrightBuild() {
  const pkg = createRequire(join(process.cwd(), "package.json")).resolve("playwright-core/package.json");
  const { browsers } = JSON.parse(readFileSync(join(dirname(pkg), "browsers.json"), "utf8"));
  return browsers.find((b) => b.name === "chromium-headless-shell")?.browserVersion;
}

/** An error's message, with the code or message of its cause (fetch reports a reset connection as its cause). */
function reason(e) {
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause ? `${e.message}: ${cause}` : String(e?.message ?? e);
}

/**
 * Downloads `url` into `file` in up to ATTEMPTS attempts, each writing the file from its start, and gives the SHA-256
 * of the bytes the successful attempt wrote. Throws, naming the last attempt's cause, when every attempt fails.
 */
async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const hash = createHash("sha256");
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (chunks) {
          for await (const chunk of chunks) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(file),
      );
      return hash.digest("hex");
    } catch (e) {
      if (attempt === ATTEMPTS) {
        throw new Error(`${url}: ${ATTEMPTS} attempts failed, the last with ${reason(e)}`, { cause: e });
      }
      const wait = 2 ** (attempt - 1);
      console.log(
        `${url}: attempt ${attempt} of ${ATTEMPTS} failed with ${reason(e)}; attempt ${attempt + 1} in ${wait} s`,
      );
      await sleep(wait * 1000);
    }
  }
}

/** Fetches the archive, checks its SHA-256, and unpacks it into website/.browser/, replacing what is there. */
async function fetchBrowser() {
  const here = `${process.platform}-${process.arch}`;
  if (here !== BROWSER.platform) {
    throw new Error(`${BROWSER.name} ${BROWSER.version} is pinned for ${BROWSER.platform}, and this machine is ${here}`);
  }
  const dir = folder();
  if (existsSync(join(dir, BROWSER.executable)) && readDigest(dir) === BROWSER.sha256) {
    console.log(`${BROWSER.name} ${BROWSER.version} (${BROWSER.platform}), SHA-256 ${BROWSER.sha256}, is in ${dir}`);
    return;
  }
  const partial = `${dir}-partial`;
  rmSync(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  try {
    const archive = join(partial, "archive.zip");
    const digest = await download(BROWSER.url, archive);
    if (digest !== BROWSER.sha256) {
      throw new Error(`${BROWSER.url} has SHA-256 ${digest}, not ${BROWSER.sha256}`);
    }
    const unpacked = join(partial, "unpacked");
    try {
      execFileSync("unzip", ["-q", archive, "-d", unpacked], { stdio: "inherit" });
    } catch (e) {
      if (e?.code === "ENOENT") throw new Error("unzip, which unpacks the archive, is not installed", { cause: e });
      throw e;
    }
    writeFileSync(join(unpacked, DIGEST_FILE), `${digest}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(unpacked, dir);
    console.log(`${BROWSER.name} ${BROWSER.version} (${BROWSER.platform}), SHA-256 ${digest}, is in ${dir}`);
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

if (import.meta.main) await fetchBrowser();
