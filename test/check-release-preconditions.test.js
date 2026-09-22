import assert from "node:assert/strict";
import { test } from "node:test";

import { checkReleasePreconditions, tagExists } from "../scripts/check-release-preconditions.js";
import { expectedIdentifier } from "../scripts/check-server-json.js";

const VERSION = "0.2.0";
const IDENTIFIER = expectedIdentifier(VERSION);

function docs({ version = VERSION, identifier = IDENTIFIER, packageVersion = VERSION, lockRootVersion = version } = {}) {
  return {
    packageJson: { version },
    packageLock: { version, packages: { "": { name: "marsdawn-mcp", version: lockRootVersion } } },
    manifest: { version },
    server: {
      version,
      packages: [{ registryType: "mcpb", identifier, version: packageVersion }],
    },
  };
}

/** A fetchImpl answering the tag lookup with `tagStatus` and the release-by-tag probe with `releaseStatus`. */
function fetching({ tagStatus, releaseStatus }) {
  return async (url) => {
    if (url.includes("/git/ref/tags/")) {
      return { ok: tagStatus >= 200 && tagStatus < 300, status: tagStatus };
    }
    if (url.includes("/releases/tags/")) {
      return { ok: releaseStatus >= 200 && releaseStatus < 300, status: releaseStatus };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const clean = () => fetching({ tagStatus: 404, releaseStatus: 404 });

test("all green: matching versions, exact identifier, no tag, no release", async () => {
  const { failures, messages } = await checkReleasePreconditions({
    ...docs(),
    token: "x",
    fetchImpl: clean(),
  });
  assert.equal(failures, 0, messages.join("\n"));
  assert.ok(messages.every((m) => m.startsWith("ok - ")));
});

// --- Red control: a planted version mismatch fails, and names every file's value. ---
test("[control] a planted version mismatch fails, naming each file's version", async () => {
  const { packageJson, packageLock, manifest, server } = docs();
  const { failures, messages } = await checkReleasePreconditions({
    packageJson,
    packageLock,
    manifest: { version: "9.9.9" },
    server,
    token: "x",
    fetchImpl: clean(),
  });
  assert.equal(failures, 1, messages.join("\n"));
  const line = messages.find((m) => m.startsWith("not ok") && m.includes("versions disagree"));
  assert.ok(line, messages.join("\n"));
  assert.match(line, /manifest\.json 9\.9\.9/);
  assert.match(line, /server\.json 0\.2\.0/);
});

// --- Red control: package-lock.json's root package entry (packages[""].version) disagreeing
// fails even though the lockfile's own top-level `version` field agrees — npm writes both, and a
// hand-edited lockfile could drift one without the other. ---
test("[control] package-lock.json's packages[\"\"].version disagreeing with the top-level version fails", async () => {
  const { packageJson, packageLock, manifest, server } = docs({ lockRootVersion: "9.9.9" });
  const { failures, messages } = await checkReleasePreconditions({
    packageJson,
    packageLock,
    manifest,
    server,
    token: "x",
    fetchImpl: clean(),
  });
  assert.equal(failures, 1, messages.join("\n"));
  const line = messages.find((m) => m.startsWith("not ok") && m.includes("versions disagree"));
  assert.ok(line, messages.join("\n"));
  assert.match(line, /package-lock\.json \(packages\[""\]\) 9\.9\.9/);
});

test("[control] packages[0].version disagreeing with server.json's version fails", async () => {
  const { packageJson, packageLock, manifest, server } = docs({ packageVersion: "9.9.9" });
  const { failures, messages } = await checkReleasePreconditions({
    packageJson,
    packageLock,
    manifest,
    server,
    token: "x",
    fetchImpl: clean(),
  });
  assert.ok(failures >= 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("packages[0].version 9.9.9 but server.json version")));
});

test("[control] a wrong identifier fails, even with no tag and no release", async () => {
  const bad = IDENTIFIER.replace("marsdawn.mcpb", "wrong-name.mcpb");
  const { packageJson, packageLock, manifest, server } = docs({ identifier: bad });
  const { failures, messages } = await checkReleasePreconditions({
    packageJson,
    packageLock,
    manifest,
    server,
    token: "x",
    fetchImpl: clean(),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("must be exactly")));
});

// --- Red control: an existing tag fails, even when everything else is clean. ---
test("[control] an existing tag v<version> fails", async () => {
  const { failures, messages } = await checkReleasePreconditions({
    ...docs(),
    token: "x",
    fetchImpl: fetching({ tagStatus: 200, releaseStatus: 404 }),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("tag v0.2.0 already exists")));
});

// --- Red control: an existing published release fails, even when there is no tag. ---
test("[control] an existing published release fails", async () => {
  const { failures, messages } = await checkReleasePreconditions({
    ...docs(),
    token: "x",
    fetchImpl: fetching({ tagStatus: 404, releaseStatus: 200 }),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("is already released")));
});

// --- Red control: both a tag and a release existing report both failures, not just one. ---
test("[control] both an existing tag and an existing release are both reported", async () => {
  const { failures, messages } = await checkReleasePreconditions({
    ...docs(),
    token: "x",
    fetchImpl: fetching({ tagStatus: 200, releaseStatus: 200 }),
  });
  assert.equal(failures, 2, messages.join("\n"));
});

// --- Red control: a non-404 error from the tag lookup fails rather than being read as "no tag". ---
test("[control] a 500 from the tag lookup fails, not passes as 'no tag'", async () => {
  const { failures, messages } = await checkReleasePreconditions({
    ...docs(),
    token: "x",
    fetchImpl: fetching({ tagStatus: 500, releaseStatus: 404 }),
  });
  assert.equal(failures, 1, messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("not ok") && m.includes("checking for tag")));
});

test("tagExists resolves true on 200, false on 404, and throws otherwise", async () => {
  assert.equal(await tagExists(VERSION, { token: "x", fetchImpl: fetching({ tagStatus: 200, releaseStatus: 404 }) }), true);
  assert.equal(await tagExists(VERSION, { token: "x", fetchImpl: fetching({ tagStatus: 404, releaseStatus: 404 }) }), false);
  await assert.rejects(() =>
    tagExists(VERSION, { token: "x", fetchImpl: fetching({ tagStatus: 500, releaseStatus: 404 }) }),
  );
  await assert.rejects(() => tagExists(VERSION, { token: undefined, fetchImpl: clean() }));
});

test("tagExists rejects when the request itself fails", async () => {
  await assert.rejects(
    () =>
      tagExists(VERSION, {
        token: "x",
        fetchImpl: async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        },
      }),
    /checking for tag v0\.2\.0 failed/,
  );
});
