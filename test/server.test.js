import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test", "fixtures");
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

/** Starts server/index.js the way a bundle host does, with MARSDAWN_PATH as the manifest sets it. */
async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "server", "index.js")],
    env: { PATH: process.env.PATH, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

test("the manifest, package.json and server agree on name, version and tools", async (t) => {
  const manifest = readJSON("manifest.json");
  const pkg = readJSON("package.json");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.license, pkg.license);
  assert.equal(manifest.server.entry_point, pkg.main);
  assert.deepEqual(manifest.compatibility.platforms, ["darwin"]);
  assert.equal(manifest.server.mcp_config.env.MARSDAWN_PATH, "${user_config.marsdawn_path}");

  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn") });
  t.after(() => client.close());
  assert.deepEqual(client.getServerVersion(), { name: "marsdawn", version: pkg.version });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), manifest.tools.map((tool) => tool.name));
});

test("the output schema is export.v1.json minus $schema, $id and title", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn") });
  t.after(() => client.close());
  const [tool] = (await client.listTools()).tools;
  const { $schema, $id, title, ...expected } = readJSON("schemas/export.v1.json");
  assert.deepEqual(tool.outputSchema, expected);
  assert.equal(tool.annotations.destructiveHint, true);
});

test("a call over stdio returns structuredContent that the client validates against outputSchema", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn"), FAKE_MARSDAWN_MODE: "success" });
  t.after(() => client.close());
  await client.listTools();
  const result = await client.callTool({
    name: "export_markdown_to_pdf",
    arguments: { input: "/Users/me/notes/plan.md", paper: "letter" },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.output, "/Users/me/notes/plan.pdf");
  assert.equal(result.structuredContent.paper, "letter");
});

test("the client rejects structuredContent that breaks outputSchema, so the check above can fail", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn"), FAKE_MARSDAWN_MODE: "bad_theme" });
  t.after(() => client.close());
  await client.listTools();
  await assert.rejects(
    client.callTool({ name: "export_markdown_to_pdf", arguments: { input: "/Users/me/notes/plan.md" } }),
    /structured content does not match the tool's output schema/i,
  );
});

test("an unfilled MARSDAWN_PATH placeholder falls back to PATH", async (t) => {
  const client = await connect({
    MARSDAWN_PATH: "${user_config.marsdawn_path}",
    PATH: `${fixtures}:${process.env.PATH}`,
    FAKE_MARSDAWN_MODE: "output_exists",
  });
  t.after(() => client.close());
  const result = await client.callTool({
    name: "export_markdown_to_pdf",
    arguments: { input: "/Users/me/notes/plan.md" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already exists\. Pass --force to replace it\. Pass `force: true`/);
});

test("an unknown tool name is an error result", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn") });
  t.after(() => client.close());
  const result = await client.callTool({ name: "does_not_exist", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No tool named does_not_exist/);
});

// --- open_in_marsdawn -------------------------------------------------------------------------

function existingFile() {
  const path = join(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")), "notes.md");
  writeFileSync(path, "# Notes\n");
  return path;
}

test("the open tool's output schema is open.v2.json minus $schema, $id and title", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn") });
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === "open_in_marsdawn");
  const { $schema, $id, title, ...expected } = readJSON("schemas/open.v2.json");
  assert.deepEqual(tool.outputSchema, expected);
  assert.equal(tool.annotations.destructiveHint, false);
});

test("open_in_marsdawn over stdio returns structuredContent that the client validates against outputSchema", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn"), FAKE_MARSDAWN_MODE: "success" });
  t.after(() => client.close());
  await client.listTools();
  const path = existingFile();
  const result = await client.callTool({ name: "open_in_marsdawn", arguments: { path } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.opened, [{ path }]);
  assert.equal(result.structuredContent.app, "/Applications/MarsDawn.app");
});

test("the client rejects open.v1.json's bare-string opened shape, so the check above can fail", async (t) => {
  // This is the bug the coordinator caught: kit 0.5.1 emits opened as [{path, line?}] (open.v2.json),
  // not [path] (open.v1.json). If openTool's outputSchema ever regressed to v1, or the fixture above
  // ever regressed to the old shape, this is what would catch it — proven here with a fixture mode
  // that deliberately emits the old shape.
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn"), FAKE_MARSDAWN_MODE: "legacy_v1_shape" });
  t.after(() => client.close());
  await client.listTools();
  const path = existingFile();
  await assert.rejects(
    client.callTool({ name: "open_in_marsdawn", arguments: { path } }),
    /structured content does not match the tool's output schema/i,
  );
});

test("open_in_marsdawn: exit code 3 (app not installed) is an error result over stdio", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn"), FAKE_MARSDAWN_MODE: "app_not_installed" });
  t.after(() => client.close());
  await client.listTools();
  const path = existingFile();
  const result = await client.callTool({ name: "open_in_marsdawn", arguments: { path } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /MarsDawn is not installed/);
});

test("open_in_marsdawn: a relative path is refused before the CLI runs", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn"), FAKE_MARSDAWN_MODE: "success" });
  t.after(() => client.close());
  await client.listTools();
  const result = await client.callTool({ name: "open_in_marsdawn", arguments: { path: "notes.md" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /absolute path/);
});

test("open_in_marsdawn: a folder is refused before the CLI runs", async (t) => {
  // Kit 0.5.1 treats a directory argument as a folder to show in the sidebar, which the launch
  // app answers with an error dialog (mars-dawn#165), and whose --json result violates open.v2.json.
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn"), FAKE_MARSDAWN_MODE: "success" });
  t.after(() => client.close());
  await client.listTools();
  const directory = mkdtempSync(join(tmpdir(), "marsdawn-mcp-"));
  const result = await client.callTool({ name: "open_in_marsdawn", arguments: { path: directory } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must be a file, not a folder/);
});

test("open_in_marsdawn: line above the schema's maximum is refused before the CLI runs", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn"), FAKE_MARSDAWN_MODE: "success" });
  t.after(() => client.close());
  await client.listTools();
  const path = existingFile();
  const result = await client.callTool({ name: "open_in_marsdawn", arguments: { path, line: 1_000_000_000 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /integer between 1 and 999999999/);
});

test("both tools are listed, and the manifest names exactly them", async (t) => {
  const client = await connect({ MARSDAWN_PATH: join(fixtures, "marsdawn") });
  t.after(() => client.close());
  const manifest = readJSON("manifest.json");
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["export_markdown_to_pdf", "open_in_marsdawn"].sort(),
  );
  assert.deepEqual(tools.map((tool) => tool.name).sort(), manifest.tools.map((tool) => tool.name).sort());
});
