import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { checkServerJson, expectedIdentifier, hashOf, probeRelease } from "../scripts/check-server-json.js";

const VERSION = "0.1.0";
const IDENTIFIER = expectedIdentifier(VERSION);
const BYTES = Buffer.from("fake mcpb bytes");
const SHA = createHash("sha256").update(BYTES).digest("hex");

function server({ version = VERSION, identifier = IDENTIFIER, packageVersion = VERSION, sha = SHA } = {}) {
  return {
    version,
    packages: [
      {
        registryType: "mcpb",
        identifier,
        version: packageVersion,
        fileSha256: sha,
      },
    ],
  };
}

const manifest = { version: VERSION };
const packageJson = { version: VERSION };

/** A fetchImpl that answers the asset download with `bytes`, and 404s everything else. */
function fetchServing(bytes, { assetOk = true } = {}) {
  return async (url) => {
    if (url === IDENTIFIER) {
      return assetOk
        ? { ok: true, arrayBuffer: async () => bytes }
        : { ok: false, status: 404 };
    }
    return { ok: false, status: 404 };
  };
}

/**
 * A fetchImpl for the GitHub release-by-tag probe: answers `status` for the probe URL. Any other
 * URL (an asset download that falls through after a "released" probe) 404s, so a test can assert
 * that fallthrough happens without also needing to serve real bytes.
 */
function fetchProbing(status) {
  return async (url) => {
    if (url.startsWith("https://api.github.com/repos/")) {
      return { ok: status >= 200 && status < 300, status };
    }
    return { ok: false, status: 404 };
  };
}

test("expectedIdentifier is the exact release-asset URL for a version", () => {
  assert.equal(
    expectedIdentifier("1.2.3"),
    "https://github.com/redtear1115/marsdawn-mcp/releases/download/v1.2.3/marsdawn.mcpb",
  );
});

test("strict: matching versions and a correct hash all pass", async () => {
  const { failures, messages } = await checkServerJson({
    server: server(),
    manifest,
    packageJson,
    fetchImpl: fetchServing(BYTES),
  });
  assert.equal(failures, 0);
  assert.ok(messages.some((m) => m.startsWith("ok - ") && m.includes("hashes to fileSha256")));
});

test("strict: server/manifest/package.json version disagreement fails", async () => {
  const { failures, messages } = await checkServerJson({
    server: server(),
    manifest: { version: "9.9.9" },
    packageJson,
    fetchImpl: fetchServing(BYTES),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("versions disagree")));
});

test("strict: a package version that disagrees with server.version fails", async () => {
  const { failures, messages } = await checkServerJson({
    server: server({ packageVersion: "9.9.9" }),
    manifest,
    packageJson,
    fetchImpl: fetchServing(BYTES),
  });
  assert.ok(failures >= 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("package version 9.9.9 but server version")));
});

// --- Red control (a): a wrong fileSha256 fails strict, even though the identifier and the
// download both succeed. ---
test("[control a] strict: a wrong fileSha256 fails, not just a mismatched download", async () => {
  const { failures, messages } = await checkServerJson({
    server: server({ sha: "0".repeat(64) }),
    manifest,
    packageJson,
    fetchImpl: fetchServing(BYTES),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("fileSha256 says")));
});

// --- Red control (b): a wrong file name in the identifier fails, both strict and with
// --allow-unreleased — the identifier check runs before either path decides anything. ---
test("[control b] a wrong file name in the identifier fails strict", async () => {
  const badIdentifier = IDENTIFIER.replace("marsdawn.mcpb", "wrong-name.mcpb");
  const { failures, messages } = await checkServerJson({
    server: server({ identifier: badIdentifier }),
    manifest,
    packageJson,
    fetchImpl: fetchServing(BYTES),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("must be exactly")));
});

test("[control b] a wrong file name in the identifier also fails on the --allow-unreleased path", async () => {
  const badIdentifier = IDENTIFIER.replace("marsdawn.mcpb", "wrong-name.mcpb");
  const { failures, messages } = await checkServerJson({
    server: server({ identifier: badIdentifier }),
    manifest,
    packageJson,
    allowUnreleased: true,
    token: "x",
    fetchImpl: fetchProbing(404), // even a clean "unreleased" probe must not mask this
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("must be exactly")));
});

// --- Red control (c): a wrong repo in the identifier fails on the --allow-unreleased path. ---
test("[control c] a wrong repo in the identifier fails on the --allow-unreleased path", async () => {
  const badIdentifier = IDENTIFIER.replace("redtear1115/marsdawn-mcp", "someone-else/marsdawn-mcp");
  const { failures, messages } = await checkServerJson({
    server: server({ identifier: badIdentifier }),
    manifest,
    packageJson,
    allowUnreleased: true,
    token: "x",
    fetchImpl: fetchProbing(404),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("must be exactly")));
});

// --- Red control (d): a released version whose identifier 404s fails, and is not skipped —
// --allow-unreleased only skips on a clean probe 404, never on the asset download 404ing. ---
test("[control d] a released version whose asset 404s fails, not skips", async () => {
  const { failures, messages } = await checkServerJson({
    server: server(),
    manifest,
    packageJson,
    allowUnreleased: true,
    token: "x",
    fetchImpl: fetchProbing(200), // the release exists: falls through to strict
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("answered 404")));
  assert.ok(!messages.some((m) => m.includes("skipping")));
});

// --- Red control (e): the probe answering 403, or the request itself failing, both fail rather
// than being treated as "unreleased". ---
test("[control e] a 403 from the probe fails", async () => {
  const { failures, messages } = await checkServerJson({
    server: server(),
    manifest,
    packageJson,
    allowUnreleased: true,
    token: "x",
    fetchImpl: fetchProbing(403),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("probing")));
});

test("[control e] a network error from the probe fails", async () => {
  const { failures, messages } = await checkServerJson({
    server: server(),
    manifest,
    packageJson,
    allowUnreleased: true,
    token: "x",
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("probing") && m.includes("failed")));
});

test("[control e] a missing token fails --allow-unreleased rather than probing unauthenticated", async () => {
  const { failures, messages } = await checkServerJson({
    server: server(),
    manifest,
    packageJson,
    allowUnreleased: true,
    token: undefined,
    fetchImpl: async () => {
      throw new Error("should not be called without a token");
    },
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("GH_TOKEN")));
});

// --- Red control (f): no --allow-unreleased flag against a bumped version whose release doesn't
// exist yet fails strict (the download 404s), rather than passing because nothing probes it. ---
test("[control f] no flag against an unreleased version fails strict", async () => {
  const { failures, messages } = await checkServerJson({
    server: server({ version: "0.2.0", packageVersion: "0.2.0", identifier: expectedIdentifier("0.2.0") }),
    manifest: { version: "0.2.0" },
    packageJson: { version: "0.2.0" },
    allowUnreleased: false,
    fetchImpl: fetchServing(BYTES, { assetOk: false }),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("answered 404")));
});

test("--allow-unreleased: a clean 404 probe skips the download and hash", async () => {
  const { failures, messages } = await checkServerJson({
    server: server({ version: "0.2.0", packageVersion: "0.2.0", identifier: expectedIdentifier("0.2.0") }),
    manifest: { version: "0.2.0" },
    packageJson: { version: "0.2.0" },
    allowUnreleased: true,
    token: "x",
    fetchImpl: fetchProbing(404),
  });
  assert.equal(failures, 0, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("ok") && m.includes("not released yet")));
});

test("probeRelease resolves 'released' on 2xx and 'unreleased' on 404, and throws otherwise", async () => {
  assert.equal(await probeRelease(VERSION, { token: "x", fetchImpl: fetchProbing(200) }), "released");
  assert.equal(await probeRelease(VERSION, { token: "x", fetchImpl: fetchProbing(404) }), "unreleased");
  await assert.rejects(() => probeRelease(VERSION, { token: "x", fetchImpl: fetchProbing(500) }));
  await assert.rejects(() => probeRelease(VERSION, { token: undefined, fetchImpl: fetchProbing(200) }));
});

test("hashOf hashes the downloaded bytes and throws on a bad status", async () => {
  assert.equal(await hashOf(IDENTIFIER, { fetchImpl: fetchServing(BYTES) }), SHA);
  await assert.rejects(() => hashOf(IDENTIFIER, { fetchImpl: fetchServing(BYTES, { assetOk: false }) }));
});
