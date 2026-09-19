// Unpacks a built marsdawn.mcpb and drives its server over stdio against a real marsdawn.
// Usage: node scripts/smoke-bundle.js path/to/marsdawn.mcpb path/to/marsdawn
//
// Checks, in order, on one Markdown file with a Mermaid diagram:
//   1. an export succeeds, the PDF is on disk, and structuredContent passes the client's
//      outputSchema validation;
//   2. the same export again is refused with output_exists, and the PDF is left alone;
//   3. with force it succeeds;
//   4. a relative path is refused;
//   5. with MARSDAWN_PATH unset and a PATH that doesn't contain marsdawn, the server still
//      finds it through the Homebrew prefixes (only when marsdawn lives in one of them).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [bundleArgument, marsdawnArgument] = process.argv.slice(2);
if (!bundleArgument || !marsdawnArgument) {
  console.error("usage: node scripts/smoke-bundle.js <marsdawn.mcpb> <marsdawn>");
  process.exit(64);
}
const bundle = resolve(bundleArgument);
const marsdawn = resolve(marsdawnArgument);

const work = mkdtempSync(join(tmpdir(), "marsdawn-smoke-"));
const unpacked = join(work, "bundle");
execFileSync("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "unpack", bundle, unpacked], { stdio: "inherit" });

const manifest = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8"));
const entry = join(unpacked, manifest.server.entry_point);
assert.ok(existsSync(entry), `the bundle has its entry point, ${manifest.server.entry_point}`);

const input = join(work, "plan.md");
writeFileSync(
  input,
  "# Plan\n\nA line of text.\n\n```mermaid\nflowchart LR\n  Draft --> Review --> Ship\n```\n",
);
const pdf = join(work, "plan.pdf");

async function connect(env) {
  // The way the manifest starts it: node <bundle>/server/index.js, env from mcp_config.
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "inherit" });
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
  await client.listTools();
  return client;
}

const call = (client, args) => client.callTool({ name: "export_markdown_to_pdf", arguments: args });
const step = (text) => console.log(`ok - ${text}`);

const client = await connect({ PATH: "/usr/bin:/bin", MARSDAWN_PATH: marsdawn });
try {
  const first = await call(client, { input });
  assert.equal(first.isError, undefined, first.content?.[0]?.text);
  assert.equal(first.structuredContent.output, pdf);
  assert.ok(first.structuredContent.pages >= 1);
  assert.ok(statSync(pdf).size > 0);
  assert.equal(readFileSync(pdf).subarray(0, 5).toString(), "%PDF-");
  step(`export wrote ${pdf}: ${first.content[0].text}`);

  const before = statSync(pdf).mtimeMs;
  const again = await call(client, { input });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /"error":"output_exists"/);
  assert.equal(statSync(pdf).mtimeMs, before);
  step("a second export without force is refused with output_exists, and the PDF is untouched");

  const forced = await call(client, { input, force: true });
  assert.equal(forced.isError, undefined, forced.content?.[0]?.text);
  step("with force it replaces the PDF");

  const relative = await call(client, { input: "plan.md" });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /absolute path/);
  step("a relative path is refused");
} finally {
  await client.close();
}

if (["/opt/homebrew/bin", "/usr/local/bin"].includes(dirname(marsdawn))) {
  const bare = await connect({ PATH: "/usr/bin:/bin", MARSDAWN_PATH: "" });
  try {
    const found = await call(bare, { input, force: true });
    assert.equal(found.isError, undefined, found.content?.[0]?.text);
    step(`with no MARSDAWN_PATH and no marsdawn in PATH, it was found in ${dirname(marsdawn)}`);
  } finally {
    await bare.close();
  }
} else {
  console.log(`skip - the Homebrew-prefix lookup (marsdawn is in ${dirname(marsdawn)})`);
}
