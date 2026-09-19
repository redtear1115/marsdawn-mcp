import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const result = await client.callTool({ name: "open", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No tool named open/);
});
