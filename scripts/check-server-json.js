// Checks what `mcp-publisher validate` doesn't: that each mcpb package in server.json can be
// downloaded and hashes to its fileSha256, and that the versions agree with the manifest.
// Usage: node scripts/check-server-json.js [path/to/server.json]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? new URL("../server.json", import.meta.url);
const server = JSON.parse(readFileSync(path, "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

let failures = 0;
const fail = (message) => {
  console.error(`not ok - ${message}`);
  failures += 1;
};
const pass = (message) => console.log(`ok - ${message}`);

if (server.version === manifest.version) pass(`server.json version ${server.version} matches manifest.json`);
else fail(`server.json version ${server.version} but manifest.json version ${manifest.version}`);

for (const pkg of server.packages ?? []) {
  if (pkg.registryType !== "mcpb") continue;
  if (pkg.version !== server.version) fail(`package version ${pkg.version} but server version ${server.version}`);
  if (!pkg.identifier.includes(`/v${pkg.version}/`)) fail(`${pkg.identifier} isn't the v${pkg.version} release`);
  if (!pkg.identifier.includes("mcp")) fail(`${pkg.identifier} must contain "mcp" for the registry`);

  const response = await fetch(pkg.identifier, { redirect: "follow" });
  if (!response.ok) {
    fail(`${pkg.identifier} answered ${response.status}`);
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha === pkg.fileSha256) pass(`${pkg.identifier} (${bytes.length} bytes) hashes to fileSha256 ${sha}`);
  else fail(`${pkg.identifier} hashes to ${sha}, but fileSha256 says ${pkg.fileSha256}`);
}

process.exit(failures === 0 ? 0 : 1);
