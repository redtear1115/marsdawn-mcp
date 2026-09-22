// Unpacks a built marsdawn.mcpb and drives its server over stdio against a real marsdawn.
// Usage: node scripts/smoke-bundle.js path/to/marsdawn.mcpb path/to/marsdawn
//
// The server is started from the manifest's own `mcp_config.args`, with `${__dirname}` and
// `${user_config.allowed_directories}` filled in the way a bundle host fills them, so the wiring
// the host relies on is exercised rather than assumed.
//
// Checks, in order, on one Markdown file with a Mermaid diagram:
//   1. an export succeeds, the PDF is on disk, and structuredContent passes the client's
//      outputSchema validation;
//   2. the same export again is refused with output_exists, and the PDF is left alone;
//   3. with force it succeeds;
//   4. a relative path is refused;
//   5. an `output` outside the allowed folder is refused and nothing is written there;
//   6. an `input` outside the allowed folder is refused;
//   7. for each odd file name, the default output is the one the server's own defaultOutputFor
//      names, and the real CLI wrote the PDF there;
//   8. with MARSDAWN_PATH unset and a PATH that doesn't contain marsdawn, the server still
//      finds it through the Homebrew prefixes (only when marsdawn lives in one of them).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [bundleArgument, marsdawnArgument] = process.argv.slice(2);
if (!bundleArgument || !marsdawnArgument) {
  console.error("usage: node scripts/smoke-bundle.js <marsdawn.mcpb> <marsdawn>");
  process.exit(64);
}
const bundle = resolve(bundleArgument);
const marsdawn = resolve(marsdawnArgument);

// Realpath'd, because that is the spelling the server compares every path against.
const work = realpathSync.native(mkdtempSync(join(tmpdir(), "marsdawn-smoke-")));
const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "marsdawn-outside-")));
const unpacked = join(work, "bundle");
execFileSync("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "unpack", bundle, unpacked], { stdio: "inherit" });

const manifest = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8"));
const entry = join(unpacked, manifest.server.entry_point);
assert.ok(existsSync(entry), `the bundle has its entry point, ${manifest.server.entry_point}`);

/** The manifest's `args`, with the substitutions a bundle host makes. `multiple: true` expands. */
function hostArgs(allowedDirectories) {
  const args = [];
  for (const argument of manifest.server.mcp_config.args) {
    if (argument === "${user_config.allowed_directories}") {
      args.push(...allowedDirectories);
      continue;
    }
    args.push(argument.replaceAll("${__dirname}", unpacked));
  }
  return args;
}

const serverArgs = hostArgs([work]);
assert.deepEqual(serverArgs, [entry, work], "the host's argv: the entry point, then each allowed folder");

const input = join(work, "plan.md");
writeFileSync(
  input,
  "# Plan\n\nA line of text.\n\n```mermaid\nflowchart LR\n  Draft --> Review --> Ship\n```\n",
);
const pdf = join(work, "plan.pdf");

// The bundle's own rule for where a PDF goes when `output` is absent.
const { defaultOutputFor } = await import(pathToFileURL(join(unpacked, "server", "allowed.js")).href);

async function connect(env) {
  // The way the manifest starts it: node <bundle>/server/index.js <folders>, env from mcp_config.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    env,
    stderr: "inherit",
  });
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

  const escape = join(outside, "escape.pdf");
  const escaping = await call(client, { input, output: escape, force: true });
  assert.equal(escaping.isError, true);
  assert.match(escaping.content[0].text, /`output` must be inside an allowed folder/);
  assert.equal(existsSync(escape), false, "nothing was written outside the allowed folder");
  step("an output outside the allowed folder is refused, and nothing is written there");

  const foreignInput = join(outside, "plan.md");
  writeFileSync(foreignInput, "# Plan\n");
  const foreign = await call(client, { input: foreignInput });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /`input` must be inside an allowed folder/);
  assert.equal(existsSync(join(outside, "plan.pdf")), false);
  step("an input outside the allowed folder is refused");

  for (const name of ["notes", ".hidden", "a.b.md", "notes."]) {
    const stem = join(work, name);
    writeFileSync(stem, "# Stem\n\nA line of text.\n");
    const result = await call(client, { input: stem, force: true });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const expected = defaultOutputFor(stem);
    assert.equal(result.structuredContent.output, expected, `the default output for ${name}`);
    assert.ok(statSync(expected).size > 0, `${expected} is on disk`);
    step(`${name} exported to ${expected}`);
  }
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
