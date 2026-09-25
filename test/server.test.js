import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = join(root, "server", "index.js");
const fixtures = join(root, "test", "fixtures");
const fakeCli = join(fixtures, "marsdawn");
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

/** A folder spelled the way `realpath.native` returns it, which is what the checks compare against. */
function temporaryTree() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")));
}

/** A temporary folder holding `plan.md`, ready to export. */
function treeWithPlan() {
  const tree = temporaryTree();
  writeFileSync(join(tree, "plan.md"), "# Plan\n");
  return tree;
}

/**
 * Starts server/index.js the way a bundle host does: the allowed folders as positional arguments,
 * the environment from `mcp_config`. `roots` makes the client declare the capability and answer
 * `roots/list` with the given handler.
 */
async function start(t, { folders = [], env = {}, roots } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript, ...folders],
    env: { PATH: process.env.PATH, MARSDAWN_PATH: fakeCli, ...env },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "test", version: "0" },
    roots ? { capabilities: { roots: { listChanged: roots.listChanged === true } } } : undefined,
  );
  if (roots) client.setRequestHandler(ListRootsRequestSchema, roots.handler);
  await client.connect(transport);
  t.after(() => client.close());
  return { client, transport };
}

/** The shorter form, for the tests that only care about the protocol surface. */
async function connect(t, env, folders = []) {
  const { client } = await start(t, { env, folders });
  return client;
}

const exportCall = (client, args) => client.callTool({ name: "export_markdown_to_pdf", arguments: args });
const openCall = (client, args) => client.callTool({ name: "open_in_marsdawn", arguments: args });

// --- the argv instrument -------------------------------------------------------------------------
// Every refusal test snapshots the file the fake CLI appends its arguments to and asserts it is
// byte-identical afterwards, so "the CLI never ran" can't pass because nothing was ever recorded.
// The same test then makes one allowed call and asserts the lines that appeared, by content.

function argvLog() {
  return join(temporaryTree(), "argv");
}

function argvBytes(log) {
  try {
    return readFileSync(log);
  } catch (error) {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

function argvLines(bytes) {
  return bytes.toString().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** The runs recorded since `before` was taken. */
function addedRuns(before, log) {
  return argvLines(argvBytes(log)).slice(argvLines(before).length);
}

/** Reads the server's own stderr until it holds `needle`. */
function stderrUntil(transport, needle, timeoutMs = 10_000) {
  let text = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stderr never held ${needle}; it held: ${text}`)), timeoutMs);
    transport.stderr.on("data", (chunk) => {
      text += chunk.toString();
      if (text.includes(needle)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });
}

// --- the protocol surface, on a real allowed tree ------------------------------------------------

test("the manifest, package.json and server agree on name, version and tools", async (t) => {
  const manifest = readJSON("manifest.json");
  const pkg = readJSON("package.json");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.license, pkg.license);
  assert.equal(manifest.server.entry_point, pkg.main);
  assert.deepEqual(manifest.compatibility.platforms, ["darwin"]);
  assert.equal(manifest.server.mcp_config.env.MARSDAWN_PATH, "${user_config.marsdawn_path}");

  const client = await connect(t, {});
  assert.deepEqual(client.getServerVersion(), { name: "marsdawn", version: pkg.version });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), manifest.tools.map((tool) => tool.name));
});

test("S10: the manifest asks the host for the allowed folders and passes them on", () => {
  const manifest = readJSON("manifest.json");
  const setting = manifest.user_config.allowed_directories;
  assert.equal(manifest.server.mcp_config.args[1], "${user_config.allowed_directories}");
  assert.equal(setting.type, "directory");
  assert.equal(setting.multiple, true);
  // Not required and no default, on purpose: the resolver Claude Desktop shares
  // (@anthropic-ai/mcpb shared/config.js) skips a required setting until the user saves a value,
  // defaults included, and never expands ${DOCUMENTS}-style placeholders inside a folder default.
  // Either would leave upgraded users with no server or a literal placeholder (measured, 2026-09-23).
  assert.equal(setting.required, false);
  assert.equal("default" in setting, false, "a folder default is inert in Claude Desktop; do not add one");
  assert.equal(typeof setting.description, "string");
});

test("the output schema is export.v1.json minus $schema, $id and title", async (t) => {
  const client = await connect(t, {});
  const [tool] = (await client.listTools()).tools;
  const { $schema, $id, title, ...expected } = readJSON("schemas/export.v1.json");
  assert.deepEqual(tool.outputSchema, expected);
  assert.equal(tool.annotations.destructiveHint, true);
});

test("S6: export's allowRemoteImages input makes the tool declare openWorldHint", async (t) => {
  const client = await connect(t, {});
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === "export_markdown_to_pdf");
  assert.ok("allowRemoteImages" in tool.inputSchema.properties, "fixture drifted: no allowRemoteImages input");
  assert.equal(
    tool.annotations.openWorldHint,
    true,
    "allowRemoteImages can make the tool fetch a URL from the rendered document; openWorldHint must be true",
  );
});

test("a call over stdio returns structuredContent that the client validates against outputSchema", async (t) => {
  const tree = treeWithPlan();
  const client = await connect(t, { FAKE_MARSDAWN_MODE: "success" }, [tree]);
  await client.listTools();
  const result = await exportCall(client, { input: join(tree, "plan.md"), paper: "letter" });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(result.structuredContent.output, join(tree, "plan.pdf"));
  assert.equal(result.structuredContent.paper, "letter");
});

test("diagramErrorDetails passes the client's outputSchema validation (kit 0.5.4, held)", async (t) => {
  // The CLI doesn't emit this field yet (kit PR redtear1115/mars-dawn-kit#118, not released); the
  // fixture stands in for it. This is what proves schemas/export.v1.json must be re-synced no
  // later than the CLI itself ships it: structuredContent is the CLI's JSON verbatim (server/
  // marsdawn.js interpretExport), so the moment a released marsdawn prints diagramErrorDetails, a
  // vendored schema that doesn't know the field yet (additionalProperties: false) makes a strict
  // client reject every export result, not just the ones with a diagram error.
  const tree = treeWithPlan();
  const details = [{ message: "Parse error on line 2", fenceLine: 5, line: 7 }, { message: "Unknown diagram type" }];
  const client = await connect(
    t,
    { FAKE_MARSDAWN_MODE: "success", FAKE_MARSDAWN_DIAGRAM_ERROR_DETAILS: JSON.stringify(details) },
    [tree],
  );
  await client.listTools();
  const result = await exportCall(client, { input: join(tree, "plan.md") });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(result.structuredContent.diagramErrorDetails, details);
});

test("the client rejects structuredContent that breaks outputSchema, so the check above can fail", async (t) => {
  const tree = treeWithPlan();
  const client = await connect(t, { FAKE_MARSDAWN_MODE: "bad_theme" }, [tree]);
  await client.listTools();
  await assert.rejects(
    exportCall(client, { input: join(tree, "plan.md") }),
    /structured content does not match the tool's output schema/i,
  );
});

test("an unfilled MARSDAWN_PATH placeholder falls back to PATH", async (t) => {
  const tree = treeWithPlan();
  const client = await connect(
    t,
    {
      MARSDAWN_PATH: "${user_config.marsdawn_path}",
      PATH: `${fixtures}:${process.env.PATH}`,
      FAKE_MARSDAWN_MODE: "output_exists",
    },
    [tree],
  );
  const result = await exportCall(client, { input: join(tree, "plan.md") });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already exists\. Pass --force to replace it\. Pass `force: true`/);
});

test("an unknown tool name is an error result", async (t) => {
  const client = await connect(t, {});
  const result = await client.callTool({ name: "does_not_exist", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No tool named does_not_exist/);
});

// --- open_in_marsdawn ----------------------------------------------------------------------------

test("the open tool's output schema is open.v2.json minus $schema, $id and title", async (t) => {
  const client = await connect(t, {});
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === "open_in_marsdawn");
  const { $schema, $id, title, ...expected } = readJSON("schemas/open.v2.json");
  assert.deepEqual(tool.outputSchema, expected);
  assert.equal(tool.annotations.destructiveHint, false);
});

test("open_in_marsdawn over stdio returns structuredContent that the client validates against outputSchema", async (t) => {
  const tree = treeWithPlan();
  const client = await connect(t, { FAKE_MARSDAWN_MODE: "success" }, [tree]);
  await client.listTools();
  const path = join(tree, "plan.md");
  const result = await openCall(client, { path });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(result.structuredContent.opened, [{ path }]);
  assert.equal(result.structuredContent.app, "/Applications/MarsDawn.app");
});

test("the client rejects open.v1.json's bare-string opened shape, so the check above can fail", async (t) => {
  // This is the bug the coordinator caught: kit 0.5.1 emits opened as [{path, line?}] (open.v2.json),
  // not [path] (open.v1.json). If openTool's outputSchema ever regressed to v1, or the fixture above
  // ever regressed to the old shape, this is what would catch it — proven here with a fixture mode
  // that deliberately emits the old shape.
  const tree = treeWithPlan();
  const client = await connect(t, { FAKE_MARSDAWN_MODE: "legacy_v1_shape" }, [tree]);
  await client.listTools();
  await assert.rejects(
    openCall(client, { path: join(tree, "plan.md") }),
    /structured content does not match the tool's output schema/i,
  );
});

test("open_in_marsdawn: exit code 3 (app not installed) is an error result over stdio", async (t) => {
  const tree = treeWithPlan();
  const client = await connect(t, { FAKE_MARSDAWN_MODE: "app_not_installed" }, [tree]);
  await client.listTools();
  const result = await openCall(client, { path: join(tree, "plan.md") });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /MarsDawn is not installed/);
});

test("open_in_marsdawn: a relative path is refused before the CLI runs", async (t) => {
  const tree = treeWithPlan();
  const client = await connect(t, { FAKE_MARSDAWN_MODE: "success" }, [tree]);
  await client.listTools();
  const result = await openCall(client, { path: "notes.md" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /absolute path/);
});

test("open_in_marsdawn: a folder is refused before the CLI runs", async (t) => {
  // Kit 0.5.1 treats a directory argument as a folder to show in the sidebar, which the launch
  // app answers with an error dialog (mars-dawn#165), and whose --json result violates open.v2.json.
  const tree = treeWithPlan();
  const folder = join(tree, "sub");
  mkdirSync(folder);
  const client = await connect(t, { FAKE_MARSDAWN_MODE: "success" }, [tree]);
  await client.listTools();
  const result = await openCall(client, { path: folder });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must be a file, not a folder/);
  assert.match(result.content[0].text, /MarsDawn 1\.1/);
});

test("open_in_marsdawn: line above the schema's maximum is refused before the CLI runs", async (t) => {
  const tree = treeWithPlan();
  const client = await connect(t, { FAKE_MARSDAWN_MODE: "success" }, [tree]);
  await client.listTools();
  const result = await openCall(client, { path: join(tree, "plan.md"), line: 1_000_000_000 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /integer between 1 and 999999999/);
});

test("both tools are listed, and the manifest names exactly them", async (t) => {
  const client = await connect(t, {});
  const manifest = readJSON("manifest.json");
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["export_markdown_to_pdf", "open_in_marsdawn"].sort(),
  );
  assert.deepEqual(tools.map((tool) => tool.name).sort(), manifest.tools.map((tool) => tool.name).sort());
});

// --- S1-S13: confinement over stdio ---------------------------------------------------------------

/** The four calls S1 and S2 make: three outside, then the allowed ones the instrument reads. */
async function assertConfined(client, { tree, outside, log }) {
  const before = argvBytes(log);

  const outsideOutput = await exportCall(client, {
    input: join(tree, "plan.md"),
    output: join(outside, "escape.pdf"),
  });
  assert.equal(outsideOutput.isError, true);
  assert.match(outsideOutput.content[0].text, /`output` must be inside an allowed folder/);

  const outsideInput = await exportCall(client, { input: join(outside, "plan.md") });
  assert.equal(outsideInput.isError, true);
  assert.match(outsideInput.content[0].text, /`input` must be inside an allowed folder/);

  const outsideOpen = await openCall(client, { path: join(outside, "plan.md") });
  assert.equal(outsideOpen.isError, true);
  assert.match(outsideOpen.content[0].text, /`path` must be inside an allowed folder/);

  assert.deepEqual(argvBytes(log), before, "a refused call must not reach the CLI");

  const exported = await exportCall(client, { input: join(tree, "plan.md") });
  assert.equal(exported.isError, undefined, exported.content?.[0]?.text);
  const opened = await openCall(client, { path: join(tree, "plan.md") });
  assert.equal(opened.isError, undefined, opened.content?.[0]?.text);
  assert.deepEqual(addedRuns(before, log), [
    ["--version"],
    ["export", join(tree, "plan.md"), "--json", "--output", join(tree, "plan.pdf")],
    ["--version"],
    ["open", join(tree, "plan.md"), "--json"],
  ]);
}

test("S1: with the client's roots as the only allowed folder, inside works and outside is refused", async (t) => {
  const tree = treeWithPlan();
  const outside = treeWithPlan();
  const log = argvLog();
  const { client } = await start(t, {
    env: { FAKE_MARSDAWN_MODE: "success", FAKE_MARSDAWN_ARGV: log },
    roots: { listChanged: true, handler: async () => ({ roots: [{ uri: pathToFileURL(tree).href }] }) },
  });
  await assertConfined(client, { tree, outside, log });
});

test("S2: with a configured folder and a client that has no roots, inside works and outside is refused", async (t) => {
  const tree = treeWithPlan();
  const outside = treeWithPlan();
  const log = argvLog();
  const { client } = await start(t, {
    folders: [tree],
    env: { FAKE_MARSDAWN_MODE: "success", FAKE_MARSDAWN_ARGV: log },
  });
  await assertConfined(client, { tree, outside, log });
});

test("S2b: a refusal names every allowed folder, in the order they were given", async (t) => {
  const first = treeWithPlan();
  const second = treeWithPlan();
  const outside = treeWithPlan();
  const { client } = await start(t, { folders: [first, second], env: { FAKE_MARSDAWN_MODE: "success" } });
  const result = await exportCall(client, { input: join(first, "plan.md"), output: join(outside, "escape.pdf") });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must be inside an allowed folder \(([^)]*)\)/);
  const listed = /\(([^)]*)\)/.exec(result.content[0].text)[1];
  assert.equal(listed, `${first}, ${second}`, "both folders, first then second, not just the first");
});

test("S3: with neither a configured folder nor roots, every call is refused with what to do", async (t) => {
  const tree = treeWithPlan();
  const log = argvLog();
  const { client } = await start(t, { env: { FAKE_MARSDAWN_MODE: "success", FAKE_MARSDAWN_ARGV: log } });
  for (const call of [
    () => exportCall(client, { input: join(tree, "plan.md") }),
    () => openCall(client, { path: join(tree, "plan.md") }),
  ]) {
    const result = await call();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No folder is allowed yet/);
    assert.match(result.content[0].text, /"Allowed folders"/);
    assert.match(result.content[0].text, /roots/);
  }
  assert.deepEqual(argvBytes(log), Buffer.alloc(0), "nothing reached the CLI");
});

test("S4: a folder given by its unresolved /var spelling still matches paths spelled that way", async (t) => {
  const raw = mkdtempSync(join(tmpdir(), "marsdawn-mcp-"));
  writeFileSync(join(raw, "plan.md"), "# Plan\n");
  const log = argvLog();
  const { client } = await start(t, {
    folders: [raw],
    env: { FAKE_MARSDAWN_MODE: "success", FAKE_MARSDAWN_ARGV: log },
  });
  const result = await exportCall(client, { input: join(raw, "plan.md") });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(addedRuns(Buffer.alloc(0), log), [
    ["--version"],
    ["export", join(raw, "plan.md"), "--json", "--output", join(raw, "plan.pdf")],
  ]);
});

test("S4 (probe): what a case-variant spelling of the allowed folder does, recorded not required", async (t) => {
  const canonical = treeWithPlan();
  const variant = join(dirname(canonical), basename(canonical).toUpperCase());
  const { client } = await start(t, { folders: [variant], env: { FAKE_MARSDAWN_MODE: "success" } });
  const result = await exportCall(client, { input: join(canonical, "plan.md") });
  const outcome = result.isError ? `refused (${result.content[0].text})` : "exported";
  console.log(`probe - a case-variant allowed folder, ${basename(variant)}: ${outcome}`);
  assert.ok(result.isError === true || result.isError === undefined);
});

test("S5: a file under a symlinked folder is refused even though it resolves back inside", async (t) => {
  const tree = treeWithPlan();
  const outside = temporaryTree();
  writeFileSync(join(tree, "y.md"), "# Y\n");
  symlinkSync(outside, join(tree, "linkdir"));
  symlinkSync(join(tree, "y.md"), join(outside, "x.md"));
  const log = argvLog();
  const { client } = await start(t, {
    folders: [tree],
    env: { FAKE_MARSDAWN_MODE: "success", FAKE_MARSDAWN_ARGV: log },
  });
  const result = await exportCall(client, {
    input: join(tree, "linkdir", "x.md"),
    output: join(tree, "x.pdf"),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /`input` must be inside an allowed folder/);
  assert.deepEqual(argvBytes(log), Buffer.alloc(0));
});

test("S6: the ways out of an allowed folder are all refused, and none of them reaches the CLI", async (t) => {
  const tree = treeWithPlan();
  const outside = treeWithPlan();
  symlinkSync(outside, join(tree, "linkdir"));

  writeFileSync(join(tree, "a.md"), "# A\n");
  symlinkSync(join(outside, "a.pdf"), join(tree, "a.pdf"));
  writeFileSync(join(tree, "b.md"), "# B\n");
  mkdirSync(join(tree, "b.pdf"));
  symlinkSync(join(outside, "dest.pdf"), join(tree, "dest.pdf"));
  symlinkSync(join(tree, "plan.md"), join(outside, "link.md"));

  const log = argvLog();
  const { client } = await start(t, {
    folders: [tree],
    env: { FAKE_MARSDAWN_MODE: "success", FAKE_MARSDAWN_ARGV: log },
  });

  const cases = [
    [
      "a .. component in `output`",
      { input: join(tree, "plan.md"), output: `${tree}/linkdir/../x.pdf` },
      /`output` must be a plain absolute path/,
    ],
    ["a .. component in `input`", { input: `${tree}/linkdir/../plan.md` }, /`input` must be a plain absolute path/],
    ["an `output` that is a symlink", { input: join(tree, "plan.md"), output: join(tree, "dest.pdf") }, /symbolic link/],
    ["a default output that is a symlink", { input: join(tree, "a.md") }, /symbolic link/],
    ["a default output that is a folder", { input: join(tree, "b.md") }, /`output` must be a regular file/],
    [
      "an input outside that links back inside",
      { input: join(outside, "link.md") },
      /`input` must be inside an allowed folder/,
    ],
    [
      "an `output` that isn't a PDF",
      { input: join(tree, "plan.md"), output: join(tree, "x.txt") },
      /`output` must name a \.pdf file/,
    ],
  ];
  for (const [what, args, pattern] of cases) {
    const result = await exportCall(client, args);
    assert.equal(result.isError, true, what);
    assert.match(result.content[0].text, pattern, what);
  }
  assert.deepEqual(argvBytes(log), Buffer.alloc(0), "no refused call reached the CLI");

  const exported = await exportCall(client, { input: join(tree, "plan.md") });
  assert.equal(exported.isError, undefined, exported.content?.[0]?.text);
  assert.deepEqual(addedRuns(Buffer.alloc(0), log), [
    ["--version"],
    ["export", join(tree, "plan.md"), "--json", "--output", join(tree, "plan.pdf")],
  ]);
});

test("S7: a client that declares roots but doesn't deliver them allows nothing, and never $HOME", async (t) => {
  const tree = treeWithPlan();
  const input = join(tree, "plan.md");
  const answers = {
    "an error": async () => {
      throw new Error("no roots for you");
    },
    "a malformed result": async () => ({ roots: "nope" }),
    "a root that isn't a file: URL": async () => ({ roots: [{ uri: "https://example.com/" }] }),
  };
  for (const [what, handler] of Object.entries(answers)) {
    const { client } = await start(t, {
      env: { HOME: tree, FAKE_MARSDAWN_MODE: "success" },
      roots: { listChanged: true, handler },
    });
    const result = await exportCall(client, { input });
    assert.equal(result.isError, true, what);
    assert.match(result.content[0].text, /No folder is allowed yet/, what);
  }

  const { client } = await start(t, {
    env: { HOME: tree, FAKE_MARSDAWN_MODE: "success" },
    roots: { listChanged: true, handler: () => new Promise(() => {}) },
  });
  const started = Date.now();
  const first = await exportCall(client, { input });
  const waited = Date.now() - started;
  assert.equal(first.isError, true);
  assert.match(first.content[0].text, /No folder is allowed yet/);
  assert.ok(waited >= 4000, `the first call waits for the 5 s timeout (waited ${waited} ms)`);

  const again = Date.now();
  const second = await exportCall(client, { input });
  assert.equal(second.isError, true);
  assert.ok(Date.now() - again < 2000, "a second call within 30 seconds doesn't wait again");
});

test("S8: without roots.listChanged the client is asked again on every call", async (t) => {
  const first = treeWithPlan();
  const second = treeWithPlan();
  let current = first;
  const { client } = await start(t, {
    env: { FAKE_MARSDAWN_MODE: "success" },
    roots: { listChanged: false, handler: async () => ({ roots: [{ uri: pathToFileURL(current).href }] }) },
  });
  assert.equal((await exportCall(client, { input: join(first, "plan.md") })).isError, undefined);
  current = second;
  const stale = await exportCall(client, { input: join(first, "plan.md") });
  assert.equal(stale.isError, true, "the old root is no longer allowed");
  assert.equal((await exportCall(client, { input: join(second, "plan.md") })).isError, undefined);
});

test("S9: a roots/list_changed notification drops the cache", async (t) => {
  const first = treeWithPlan();
  const second = treeWithPlan();
  let current = first;
  const { client } = await start(t, {
    env: { FAKE_MARSDAWN_MODE: "success" },
    roots: { listChanged: true, handler: async () => ({ roots: [{ uri: pathToFileURL(current).href }] }) },
  });
  assert.equal((await exportCall(client, { input: join(first, "plan.md") })).isError, undefined);
  current = second;
  assert.equal(
    (await exportCall(client, { input: join(second, "plan.md") })).isError,
    true,
    "until the client says so, the cached root stands",
  );
  await client.sendRootsListChanged();
  assert.equal((await exportCall(client, { input: join(second, "plan.md") })).isError, undefined);
  assert.equal((await exportCall(client, { input: join(first, "plan.md") })).isError, true);
});

test("S9b: a roots/list_changed that arrives while roots/list is being answered isn't lost", async (t) => {
  // The first answer is held back until the client has announced a change; the answer it then
  // gives is from before that change, so it may serve the call that asked but must not be kept.
  const first = treeWithPlan();
  const second = treeWithPlan();
  const log = argvLog();
  let asked = 0;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let firstAsked;
  const askedOnce = new Promise((resolve) => {
    firstAsked = resolve;
  });
  const { client } = await start(t, {
    env: { FAKE_MARSDAWN_MODE: "success", FAKE_MARSDAWN_ARGV: log },
    roots: {
      listChanged: true,
      handler: async () => {
        asked += 1;
        if (asked === 1) {
          firstAsked();
          await held;
          return { roots: [{ uri: pathToFileURL(first).href }] };
        }
        return { roots: [{ uri: pathToFileURL(second).href }] };
      },
    },
  });
  const inFlight = exportCall(client, { input: join(first, "plan.md") });
  await askedOnce;
  await client.sendRootsListChanged();
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  await inFlight;
  assert.equal(asked, 1, "only the held request so far");

  const before = argvBytes(log);
  const stale = await exportCall(client, { input: join(first, "plan.md") });
  assert.equal(asked, 2, "the next call asks for roots again");
  assert.equal(stale.isError, true, "the root from before the change is no longer allowed");
  assert.match(stale.content[0].text, /`input` must be inside an allowed folder/);
  assert.deepEqual(argvBytes(log), before, "the refused call didn't reach the CLI");

  const fresh = await exportCall(client, { input: join(second, "plan.md") });
  assert.equal(fresh.isError, undefined, fresh.content?.[0]?.text);
  assert.equal(asked, 2, "an answer given after the change is cached as before");
});

test("S9c: a roots/list failure that lands after a roots/list_changed doesn't hold off the next ask", async (t) => {
  // Without the change, a failure is remembered for 30 seconds; with one in between, the failure
  // is about the old roots, so the next call asks straight away.
  const tree = treeWithPlan();
  let asked = 0;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let firstAsked;
  const askedOnce = new Promise((resolve) => {
    firstAsked = resolve;
  });
  const { client } = await start(t, {
    env: { FAKE_MARSDAWN_MODE: "success" },
    roots: {
      listChanged: true,
      handler: async () => {
        asked += 1;
        if (asked === 1) {
          firstAsked();
          await held;
          throw new Error("not yet");
        }
        return { roots: [{ uri: pathToFileURL(tree).href }] };
      },
    },
  });
  const inFlight = exportCall(client, { input: join(tree, "plan.md") });
  await askedOnce;
  await client.sendRootsListChanged();
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  const failed = await inFlight;
  assert.equal(failed.isError, true, "the call whose roots/list failed allows nothing");

  const next = await exportCall(client, { input: join(tree, "plan.md") });
  assert.equal(asked, 2, "the next call asked again instead of waiting out the failure");
  assert.equal(next.isError, undefined, next.content?.[0]?.text);
});

test("S11: open says the same thing about a path outside whether or not it exists", async (t) => {
  const tree = treeWithPlan();
  const outside = treeWithPlan();
  const log = argvLog();
  const { client } = await start(t, {
    folders: [tree],
    env: { FAKE_MARSDAWN_MODE: "success", FAKE_MARSDAWN_ARGV: log },
  });
  const existing = await openCall(client, { path: join(outside, "plan.md") });
  const missing = await openCall(client, { path: join(outside, "nothing-here.md") });
  assert.equal(existing.isError, true);
  assert.equal(missing.isError, true);
  assert.equal(existing.content[0].text, missing.content[0].text);
  assert.match(existing.content[0].text, /`path` must be inside an allowed folder/);
  assert.deepEqual(argvBytes(log), Buffer.alloc(0));
});

test("S12: a missing file inside an allowed folder is still the CLI's `input_not_found`", async (t) => {
  const tree = treeWithPlan();
  const missing = join(tree, "missing.md");
  const log = argvLog();
  const { client } = await start(t, {
    folders: [tree],
    env: { FAKE_MARSDAWN_MODE: "input_not_found", FAKE_MARSDAWN_ARGV: log },
  });
  const result = await exportCall(client, { input: missing });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, new RegExp(`No such file: ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result.content[0].text, /Check that `input` is the absolute path/);
  assert.deepEqual(addedRuns(Buffer.alloc(0), log), [
    ["--version"],
    ["export", missing, "--json", "--output", join(tree, "missing.pdf")],
  ]);
});

test("S14: a dangling symlink input is refused like one that points outside; a missing plain file isn't", async (t) => {
  const tree = treeWithPlan();
  const outside = treeWithPlan();
  symlinkSync(join(outside, "plan.md"), join(tree, "link-out.md"));
  symlinkSync(join(outside, "gone.md"), join(tree, "dangling-out.md"));
  symlinkSync(join(tree, "gone.md"), join(tree, "dangling-in.md"));
  const log = argvLog();
  const { client } = await start(t, {
    folders: [tree],
    env: { FAKE_MARSDAWN_MODE: "input_not_found", FAKE_MARSDAWN_ARGV: log },
  });

  const exportOut = await exportCall(client, { input: join(tree, "link-out.md") });
  const openOut = await openCall(client, { path: join(tree, "link-out.md") });
  assert.match(exportOut.content[0].text, /`input` must be inside an allowed folder/);
  assert.match(openOut.content[0].text, /`path` must be inside an allowed folder/);
  for (const name of ["dangling-out.md", "dangling-in.md"]) {
    const exported = await exportCall(client, { input: join(tree, name) });
    assert.equal(exported.isError, true, name);
    assert.equal(exported.content[0].text, exportOut.content[0].text, `export, ${name}`);
    const opened = await openCall(client, { path: join(tree, name) });
    assert.equal(opened.isError, true, name);
    assert.equal(opened.content[0].text, openOut.content[0].text, `open, ${name}`);
  }
  assert.deepEqual(argvBytes(log), Buffer.alloc(0), "no symlink reached the CLI");

  const missing = join(tree, "missing.md");
  const result = await exportCall(client, { input: missing });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Check that `input` is the absolute path/);
  assert.deepEqual(addedRuns(Buffer.alloc(0), log), [
    ["--version"],
    ["export", missing, "--json", "--output", join(tree, "missing.pdf")],
  ]);
});

test("S13: the startup line on stderr names the version and every positional argument", async (t) => {
  const first = temporaryTree();
  const second = temporaryTree();
  const { version } = readJSON("package.json");
  const { transport } = await start(t, { folders: [first, second] });
  const text = await stderrUntil(transport, "argv:");
  const line = text.split("\n").find((candidate) => candidate.includes("argv:"));
  assert.equal(line, `marsdawn-mcp ${version} argv: ${JSON.stringify([first, second])}`);
  assert.deepEqual(JSON.parse(line.slice(line.indexOf("argv:") + "argv:".length).trim()), [first, second]);
});
