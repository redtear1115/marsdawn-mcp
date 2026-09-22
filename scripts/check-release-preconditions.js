// release.yml's step 1 ("Consistency"): before job `build` does anything else, every version
// field in the tree must agree, `server.json`'s `packages[0].identifier` must be exactly this
// version's release-asset URL, and neither the tag `v<version>` nor a published release for it
// may exist yet — both checked with a read-only token, both required so the workflow never races
// its own output. Reuses `check-server-json.js`'s `expectedIdentifier` and `probeRelease` rather
// than re-deriving them, so the identifier rule and the "what counts as released" rule can't
// drift between the two scripts.
//
// Usage: node scripts/check-release-preconditions.js [path/to/server.json]

import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO, expectedIdentifier, probeRelease } from "./check-server-json.js";

/**
 * Whether `v<version>` already exists as a git tag, checked with a read-only token via the single
 * ref lookup (`GET git/ref/tags/v<version>`). Resolves `true`/`false` on a clean 200/404; throws
 * for anything else (a non-404 error status, a missing token, or the request failing), since none
 * of those tell us it's safe to say "no tag".
 */
export async function tagExists(version, { fetchImpl = fetch, token = process.env.GH_TOKEN } = {}) {
  if (!token) {
    throw new Error("no GH_TOKEN set to check for an existing tag");
  }
  const url = `https://api.github.com/repos/${REPO}/git/ref/tags/v${version}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
  } catch (error) {
    throw new Error(`checking for tag v${version} failed: ${error.message}`);
  }
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`checking for tag v${version} answered ${response.status}`);
}

/**
 * Runs every precondition against the parsed documents and returns `{ failures, messages }`, in
 * the same TAP-style `ok - `/`not ok - ` shape as `checkServerJson`. Never throws: a rejected tag
 * or release lookup is caught and turned into a `not ok` line.
 */
export async function checkReleasePreconditions({
  packageJson,
  packageLock,
  manifest,
  server,
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

  const version = server.version;
  const fields = {
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    "manifest.json": manifest.version,
    "server.json": version,
  };
  const disagreeing = Object.entries(fields).filter(([, v]) => v !== version);
  if (disagreeing.length === 0) {
    pass(`package.json, package-lock.json, manifest.json and server.json all agree on version ${version}`);
  } else {
    const said = Object.entries(fields)
      .map(([file, v]) => `${file} ${v}`)
      .join(", ");
    fail(`versions disagree: ${said}`);
  }

  const pkg = server.packages?.[0];
  if (!pkg) {
    fail("server.json has no packages[0]");
  } else {
    if (pkg.version === version) {
      pass(`packages[0].version ${pkg.version} matches server.json's ${version}`);
    } else {
      fail(`packages[0].version ${pkg.version} but server.json version ${version}`);
    }

    const expected = expectedIdentifier(version);
    if (pkg.identifier === expected) {
      pass(`packages[0].identifier is exactly ${expected}`);
    } else {
      fail(`packages[0].identifier ${pkg.identifier} must be exactly ${expected}`);
    }
  }

  try {
    const exists = await tagExists(version, { fetchImpl, token });
    if (exists) {
      fail(`tag v${version} already exists; the release workflow creates it, so it must not exist yet`);
    } else {
      pass(`tag v${version} does not exist yet`);
    }
  } catch (error) {
    fail(`checking for tag v${version} failed: ${error.message}`);
  }

  try {
    const probed = await probeRelease(version, { fetchImpl, token });
    if (probed === "unreleased") {
      pass(`v${version} has no published release yet`);
    } else {
      fail(`v${version} is already released; delete or rerun with stamp_only, per CONTRIBUTING`);
    }
  } catch (error) {
    fail(`probing the v${version} release failed: ${error.message}`);
  }

  return { failures, messages };
}

async function main() {
  const args = process.argv.slice(2);
  const serverPath = args.find((arg) => !arg.startsWith("--")) ?? new URL("../server.json", import.meta.url);
  const dir = dirname(typeof serverPath === "string" ? serverPath : fileURLToPath(serverPath));

  const server = JSON.parse(readFileSync(serverPath, "utf8"));
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
  const packageJson = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  const packageLock = JSON.parse(readFileSync(`${dir}/package-lock.json`, "utf8"));

  const { failures, messages } = await checkReleasePreconditions({ server, manifest, packageJson, packageLock });
  for (const message of messages) {
    (message.startsWith("not ok") ? console.error : console.log)(message);
  }
  process.exit(failures === 0 ? 0 : 1);
}

/** Same run-directly guard as check-server-json.js: see its isMainModule for why. */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
