import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { fetchAndVerifyAssetSha256, stampFileSha256 } from "../scripts/stamp-server-json.js";
import { expectedIdentifier } from "../scripts/check-server-json.js";

const VERSION = "0.2.0";
const IDENTIFIER = expectedIdentifier(VERSION);
const BYTES = Buffer.from("the published mcpb's real bytes");
const SHA = createHash("sha256").update(BYTES).digest("hex");

function server({ version = VERSION, identifier = IDENTIFIER, fileSha256 = "0".repeat(64) } = {}) {
  return {
    version,
    packages: [{ registryType: "mcpb", identifier, version, fileSha256 }],
    unrelatedTopLevelField: "left alone",
  };
}

function fetchServing(bytes, { ok = true } = {}) {
  return async (url) => {
    assert.equal(url, IDENTIFIER);
    return ok ? { ok: true, arrayBuffer: async () => bytes } : { ok: false, status: 404 };
  };
}

test("stampFileSha256 replaces only packages[0].fileSha256", () => {
  const before = server({ fileSha256: "placeholder".padEnd(64, "0") });
  const after = stampFileSha256(before, VERSION, SHA);
  assert.equal(after.packages[0].fileSha256, SHA);
  assert.equal(after.packages[0].identifier, IDENTIFIER);
  assert.equal(after.packages[0].version, VERSION);
  assert.equal(after.unrelatedTopLevelField, "left alone");
  // The input is untouched — a caller relying on the old object (e.g. to log the placeholder) isn't surprised.
  assert.equal(before.packages[0].fileSha256, "placeholder".padEnd(64, "0"));
});

// --- Red control: stamping the wrong version's server.json (a mismatched packages[0].version)
// throws rather than silently overwriting the wrong package's hash. ---
test("[control] stamping a server.json whose packages[0].version disagrees throws", () => {
  assert.throws(() => stampFileSha256(server({ version: "0.1.0" }), VERSION, SHA), /not the version being stamped/);
});

// --- Red control: stamping a server.json whose identifier doesn't match this version's expected
// URL throws — catches a stale or hand-edited identifier before it gets a fresh hash stapled to it. ---
test("[control] stamping a server.json with a mismatched identifier throws", () => {
  const bad = server({ identifier: IDENTIFIER.replace("marsdawn.mcpb", "wrong-name.mcpb") });
  assert.throws(() => stampFileSha256(bad, VERSION, SHA), /packages\[0\]\.identifier is/);
});

test("[control] stamping a server.json with no packages throws", () => {
  assert.throws(() => stampFileSha256({ version: VERSION, packages: [] }, VERSION, SHA), /no packages\[0\]/);
});

test("fetchAndVerifyAssetSha256 hashes the downloaded asset", async () => {
  const sha256 = await fetchAndVerifyAssetSha256(VERSION, { fetchImpl: fetchServing(BYTES) });
  assert.equal(sha256, SHA);
});

test("fetchAndVerifyAssetSha256 with a matching expectSha256 passes it through", async () => {
  const sha256 = await fetchAndVerifyAssetSha256(VERSION, { expectSha256: SHA, fetchImpl: fetchServing(BYTES) });
  assert.equal(sha256, SHA);
});

// --- Red control: a downloaded asset that doesn't match the build job's expected hash throws,
// rather than silently stamping whatever it downloaded. This is the "verify sha again" re-check. ---
test("[control] a downloaded asset that doesn't match expectSha256 throws", async () => {
  await assert.rejects(
    () => fetchAndVerifyAssetSha256(VERSION, { expectSha256: "0".repeat(64), fetchImpl: fetchServing(BYTES) }),
    /hashes to .+, but expected/,
  );
});

// --- Red control: a failed download throws instead of stamping nothing/garbage. ---
test("[control] a failed asset download throws", async () => {
  await assert.rejects(() => fetchAndVerifyAssetSha256(VERSION, { fetchImpl: fetchServing(BYTES, { ok: false }) }));
});

// main() itself wires fetchAndVerifyAssetSha256 and stampFileSha256 together with no logic of its
// own beyond argv parsing and the file read/write, both exercised directly above; hitting main()
// through the CLI would mean either a real network call (out of scope offline) or a fetch stub
// file the script has no hook for, so those two functions are the right unit here.

test("the CLI exits 64 with a usage message when no version is given", async () => {
  const { execFileSync } = await import("node:child_process");
  const scriptPath = new URL("../scripts/stamp-server-json.js", import.meta.url);
  assert.throws(() => execFileSync(process.execPath, [scriptPath.pathname], { encoding: "utf8" }), (error) => {
    assert.equal(error.status, 64);
    assert.match(error.stderr, /usage: node scripts\/stamp-server-json\.js/);
    return true;
  });
});
