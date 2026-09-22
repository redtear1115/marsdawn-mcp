// Checks what `mcp-publisher validate` doesn't: that server.json, manifest.json and package.json
// agree on `version`, that each mcpb package's identifier is exactly the GitHub release asset URL
// for that version, and (strict by default) that the asset can be downloaded and hashes to
// `fileSha256`.
//
// `--allow-unreleased` (used only by ci.yml's `server-json` job, against a version-bump PR before
// its release exists) skips the download and hash for a package whose version has no release yet
// — but only when the GitHub API says so with a plain 404 on the release-by-tag lookup. Anything
// else (2xx, 403, 5xx, a network error, or a missing token) fails: a 2xx means the release exists,
// so the check runs strict instead of skipping.
//
// Usage: node scripts/check-server-json.js [path/to/server.json] [--allow-unreleased]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "redtear1115/marsdawn-mcp";

/** The exact release-asset URL a package's `identifier` must equal for the given version. */
export function expectedIdentifier(version) {
  return `https://github.com/${REPO}/releases/download/v${version}/marsdawn.mcpb`;
}

/**
 * Whether `v<version>` has been published as a GitHub release. Resolves to "released" (the API
 * returned the release) or "unreleased" (a clean 404 — no such tag exists yet). Throws for
 * anything else: a non-404 error status, a missing token, or the request itself failing, since
 * none of those tell us it's safe to skip the download and hash.
 */
export async function probeRelease(version, { fetchImpl = fetch, token = process.env.GH_TOKEN } = {}) {
  if (!token) {
    throw new Error("no GH_TOKEN set to probe the release with --allow-unreleased");
  }
  const url = `https://api.github.com/repos/${REPO}/releases/tags/v${version}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
  } catch (error) {
    throw new Error(`probing ${url} failed: ${error.message}`);
  }
  if (response.status === 404) return "unreleased";
  if (response.ok) return "released";
  throw new Error(`probing ${url} answered ${response.status}`);
}

/** Downloads `url` and returns the sha256 of its bytes as lowercase hex. Throws on a bad status. */
export async function hashOf(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Runs every check against the parsed documents and returns `{ failures, messages }`. `messages`
 * are TAP-style `ok - `/`not ok - ` lines in the order they were produced; `failures` is the count
 * of `not ok` lines. Never throws: a rejected probe or download is caught and turned into a
 * `not ok` line, since one package's network trouble shouldn't stop the others from being checked.
 */
export async function checkServerJson({
  server,
  manifest,
  packageJson,
  allowUnreleased = false,
  fetchImpl = fetch,
  token = process.env.GH_TOKEN,
} = {}) {
  const messages = [];
  let failures = 0;
  const fail = (message) => {
    messages.push(`not ok - ${message}`);
    failures += 1;
  };
  const pass = (message) => messages.push(`ok - ${message}`);

  if (server.version === manifest.version && server.version === packageJson.version) {
    pass(`server.json version ${server.version} matches manifest.json and package.json`);
  } else {
    fail(
      `versions disagree: server.json ${server.version}, manifest.json ${manifest.version}, package.json ${packageJson.version}`,
    );
  }

  for (const pkg of server.packages ?? []) {
    if (pkg.registryType !== "mcpb") continue;

    if (pkg.version !== server.version) {
      fail(`package version ${pkg.version} but server version ${server.version}`);
    }

    const expected = expectedIdentifier(pkg.version);
    if (pkg.identifier !== expected) {
      fail(`identifier ${pkg.identifier} must be exactly ${expected}`);
      continue; // wrong URL: nothing to probe or download for it
    }

    if (allowUnreleased) {
      let probed;
      try {
        probed = await probeRelease(pkg.version, { fetchImpl, token });
      } catch (error) {
        fail(`probing the v${pkg.version} release failed: ${error.message}`);
        continue;
      }
      if (probed === "unreleased") {
        pass(`v${pkg.version} is not released yet; skipping the download and hash`);
        continue;
      }
      // "released": fall through to the strict hash check below.
    }

    try {
      const sha = await hashOf(pkg.identifier, { fetchImpl });
      if (sha === pkg.fileSha256) {
        pass(`${pkg.identifier} hashes to fileSha256 ${sha}`);
      } else {
        fail(`${pkg.identifier} hashes to ${sha}, but fileSha256 says ${pkg.fileSha256}`);
      }
    } catch (error) {
      fail(`${pkg.identifier}: ${error.message}`);
    }
  }

  return { failures, messages };
}

async function main() {
  const args = process.argv.slice(2);
  const allowUnreleased = args.includes("--allow-unreleased");
  const serverPath = args.find((arg) => !arg.startsWith("--")) ?? new URL("../server.json", import.meta.url);
  const dir = dirname(typeof serverPath === "string" ? serverPath : fileURLToPath(serverPath));

  const server = JSON.parse(readFileSync(serverPath, "utf8"));
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
  const packageJson = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));

  const { failures, messages } = await checkServerJson({ server, manifest, packageJson, allowUnreleased });
  for (const message of messages) {
    (message.startsWith("not ok") ? console.error : console.log)(message);
  }
  process.exit(failures === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
