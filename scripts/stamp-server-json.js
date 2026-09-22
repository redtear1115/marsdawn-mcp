// release.yml's step 5 ("Stamp"): after a release is published, download its asset, hash it, and
// patch server.json's packages[0].fileSha256 to the real value — the placeholder left by the
// version-bump PR (server.json isn't in the bundle, so this can't be done before the asset
// exists). Used both by job `publish` (with an `--expect-sha256` it re-checks against job
// `build`'s output) and, standalone, by job `stamp` (the `stamp_only` recovery path, with no build
// in this run to compare against — the downloaded asset's hash is the only source of truth).
//
// Only `fileSha256` changes; every other field, and the file's formatting, is left as it read.
//
// Usage: node scripts/stamp-server-json.js <version> [path/to/server.json] [--expect-sha256=<hex>]

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expectedIdentifier, hashOf } from "./check-server-json.js";

/**
 * Returns a copy of `server` with `packages[0].fileSha256` replaced by `sha256`, after checking
 * that `packages[0]` is the package for `version` (its own version and identifier match) — so a
 * caller can never silently stamp the wrong package. Throws otherwise. No other field is touched.
 */
export function stampFileSha256(server, version, sha256) {
  const pkg = server.packages?.[0];
  if (!pkg) {
    throw new Error("server.json has no packages[0] to stamp");
  }
  if (pkg.version !== version) {
    throw new Error(`packages[0].version is ${pkg.version}, not the version being stamped, ${version}`);
  }
  const expected = expectedIdentifier(version);
  if (pkg.identifier !== expected) {
    throw new Error(`packages[0].identifier is ${pkg.identifier}, not ${expected}`);
  }
  return {
    ...server,
    packages: [{ ...pkg, fileSha256: sha256 }, ...server.packages.slice(1)],
  };
}

/**
 * Downloads `v<version>`'s published asset, hashes it, checks that hash against `expectSha256`
 * when one is given, and returns the hash. Throws on a download failure or a mismatch — the
 * caller must not stamp a hash it hasn't verified.
 */
export async function fetchAndVerifyAssetSha256(version, { expectSha256, fetchImpl = fetch } = {}) {
  const url = expectedIdentifier(version);
  const sha256 = await hashOf(url, { fetchImpl });
  if (expectSha256 && sha256 !== expectSha256) {
    throw new Error(`${url} hashes to ${sha256}, but expected ${expectSha256}`);
  }
  return sha256;
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const version = positional[0];
  if (!version) {
    console.error("usage: node scripts/stamp-server-json.js <version> [path/to/server.json] [--expect-sha256=<hex>]");
    process.exit(64);
  }
  const serverPath = positional[1] ?? new URL("../server.json", import.meta.url);
  const expectArg = args.find((arg) => arg.startsWith("--expect-sha256="));
  const expectSha256 = expectArg ? expectArg.slice("--expect-sha256=".length) : undefined;

  const server = JSON.parse(readFileSync(serverPath, "utf8"));

  const sha256 = await fetchAndVerifyAssetSha256(version, { expectSha256 });
  console.log(`ok - v${version}'s published asset hashes to ${sha256}`);

  const stamped = stampFileSha256(server, version, sha256);
  writeFileSync(serverPath, `${JSON.stringify(stamped, null, 2)}\n`);
  console.log(`ok - wrote packages[0].fileSha256 = ${sha256} to ${serverPath}`);
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
