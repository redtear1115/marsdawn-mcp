import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NEXT_STEPS,
  buildExportArguments,
  buildOpenArguments,
  configuredPathFrom,
  createExporter,
  createOpener,
  errorSchema,
  isAtLeast,
  locateMarsdawn,
  parseVersion,
} from "../server/marsdawn.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fake = join(fixtures, "marsdawn");
chmodSync(fake, 0o755);

/** An exporter that finds the fake through PATH alone, with Homebrew's prefixes switched off. */
function fakeExporter(mode, extraEnv = {}, options = {}) {
  const env = { ...process.env, PATH: `${fixtures}:${process.env.PATH}`, FAKE_MARSDAWN_MODE: mode, ...extraEnv };
  return createExporter({ env, fallbacks: [], ...options });
}

/** An opener that finds the fake through PATH alone, with Homebrew's prefixes switched off. */
function fakeOpener(mode, extraEnv = {}, options = {}) {
  const env = { ...process.env, PATH: `${fixtures}:${process.env.PATH}`, FAKE_MARSDAWN_MODE: mode, ...extraEnv };
  return createOpener({ env, fallbacks: [], ...options });
}

const input = "/Users/me/notes/plan.md";

/** A real file on disk, since `buildOpenArguments` checks the filesystem by default. */
function existingFile() {
  const path = join(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")), "notes.md");
  writeFileSync(path, "# Notes\n");
  return path;
}

test("the exit-code table has a next step for every error kind the schema allows", () => {
  assert.deepEqual(Object.keys(NEXT_STEPS).sort(), [...errorSchema.properties.error.enum].sort());
});

test("arguments: an absolute input becomes `export <input> --json`", () => {
  assert.deepEqual(buildExportArguments({ input }).args, ["export", input, "--json"]);
});

test("arguments: every option maps to its flag", () => {
  const { args } = buildExportArguments({
    input,
    output: "/tmp/out.pdf",
    theme: "vivid",
    paper: "letter",
    force: true,
    allowRemoteImages: true,
  });
  assert.deepEqual(args, [
    "export", input, "--json",
    "--output", "/tmp/out.pdf",
    "--theme", "vivid",
    "--paper", "letter",
    "--force",
    "--allow-remote-images",
  ]);
});

test("arguments: false flags add nothing", () => {
  assert.deepEqual(buildExportArguments({ input, force: false, allowRemoteImages: false }).args, ["export", input, "--json"]);
});

test("arguments: relative, tilde and option-like paths are refused", () => {
  for (const bad of ["plan.md", "./plan.md", "~/plan.md", "--force", "-o", "", undefined, 42]) {
    assert.match(buildExportArguments({ input: bad }).error, /absolute path/, `input ${String(bad)}`);
  }
  assert.match(buildExportArguments({ input, output: "out.pdf" }).error, /`output` must be an absolute path/);
});

test("arguments: values outside the schema's enums are refused", () => {
  assert.match(buildExportArguments({ input, theme: "dark" }).error, /dawn, classic, modern, vivid/);
  assert.match(buildExportArguments({ input, paper: "A4" }).error, /a4, letter/);
  assert.match(buildExportArguments({ input, force: "yes" }).error, /`force` must be true or false/);
});

test("versions: 0.5.0 and later pass, earlier fails", () => {
  const minimum = parseVersion("0.5.0");
  assert.equal(isAtLeast(parseVersion("0.5.0\n"), minimum), true);
  assert.equal(isAtLeast(parseVersion("0.10.0"), minimum), true);
  assert.equal(isAtLeast(parseVersion("1.0.0"), minimum), true);
  assert.equal(isAtLeast(parseVersion("0.4.1"), minimum), false);
  assert.equal(parseVersion("marsdawn"), null);
});

test("configured path: empty and unfilled placeholders mean not configured", () => {
  assert.equal(configuredPathFrom(undefined), undefined);
  assert.equal(configuredPathFrom(""), undefined);
  assert.equal(configuredPathFrom("  "), undefined);
  assert.equal(configuredPathFrom("${user_config.marsdawn_path}"), undefined);
  assert.equal(configuredPathFrom("/opt/tools/marsdawn"), "/opt/tools/marsdawn");
});

test("locate: the configured path wins over PATH", async () => {
  const found = await locateMarsdawn({ configuredPath: fake, env: { PATH: "" }, fallbacks: [] });
  assert.equal(found.path, fake);
});

test("locate: a configured path that isn't executable is an error, not a fallback", async () => {
  const found = await locateMarsdawn({ configuredPath: fixtures, env: { PATH: fixtures }, fallbacks: [] });
  assert.match(found.error, /isn't an executable file/);
});

test("locate: with no PATH at all, the fallback directories are searched", async () => {
  const found = await locateMarsdawn({ env: {}, fallbacks: ["/nonexistent", fixtures] });
  assert.equal(found.path, fake);
});

test("locate: nothing anywhere says how to install it", async () => {
  const found = await locateMarsdawn({ env: { PATH: "/nonexistent" }, fallbacks: [] });
  assert.match(found.error, /marsdawn isn't installed\. Install it with `brew install redtear1115\/tap\/marsdawn`/);
});

test("export: success returns the CLI's JSON as structuredContent", async () => {
  const result = await fakeExporter("success")({ input, theme: "classic" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    diagramErrors: [],
    ok: true,
    output: "/Users/me/notes/plan.pdf",
    pages: 1,
    paper: "a4",
    theme: "classic",
  });
  assert.equal(result.content[0].text, "Exported /Users/me/notes/plan.pdf (1 page, theme classic, paper a4).");
});

test("export: diagram errors are reported alongside a success", async () => {
  const result = await fakeExporter("success", { FAKE_MARSDAWN_DIAGRAM_ERROR: "Parse error on line 2" })({ input });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /A diagram didn't render: Parse error on line 2/);
});

test("export: the CLI is given exactly the built arguments", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")), "argv");
  await fakeExporter("success", { FAKE_MARSDAWN_ARGV: log })({ input, paper: "letter", force: true });
  const runs = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(runs, [["--version"], ["export", input, "--json", "--paper", "letter", "--force"]]);
});

for (const [mode, kind, pattern] of [
  ["input_not_found", "input_not_found", /No such file: \/Users\/me\/notes\/plan\.md/],
  ["output_exists", "output_exists", /Pass `force: true` to replace it/],
  ["export_failed", "export_failed", /Export failed: the page could not be laid out\. Nothing was written/],
]) {
  test(`export: exit code for ${kind} becomes isError with the CLI's message and a next step`, async () => {
    const result = await fakeExporter(mode)({ input });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.match(result.content[0].text, pattern);
    assert.match(result.content[0].text, new RegExp(`"error":"${kind}"`));
  });
}

test("export: a usage error (exit 64) passes stderr on", async () => {
  const result = await fakeExporter("usage")({ input });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /failed \(exit code 64\):\nError: Unknown option '--bogus'/);
});

test("export: exit 0 without a --json line is an error, not a success", async () => {
  for (const mode of ["not_json", "incomplete"]) {
    const result = await fakeExporter(mode)({ input });
    assert.equal(result.isError, true, mode);
    assert.match(result.content[0].text, /succeeded but didn't print a --json result/, mode);
  }
});

test("export: a long non-JSON line is cut short in the error", async () => {
  const result = await fakeExporter("long_line")({ input });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.length < 2200, `length ${result.content[0].text.length}`);
  assert.match(result.content[0].text, /…$/);
});

test("export: an error kind the schema doesn't list is shown raw", async () => {
  const result = await fakeExporter("unknown_kind")({ input });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /failed \(exit code 5\):\n\{"ok":false,"error":"something_new"/);
});

test("export: a run that doesn't finish is stopped at the timeout", async () => {
  const started = Date.now();
  const result = await fakeExporter("hang", {}, { timeoutMs: 1500 })({ input });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /didn't finish within 1\.5 seconds and was stopped/);
  assert.ok(Date.now() - started < 10_000);
});

test("export: output past the size cap is an error", async () => {
  const result = await fakeExporter("flood")({ input });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /printed more than 1048576 bytes/);
});

test("export: a marsdawn older than 0.5.0 is refused before exporting", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")), "argv");
  const result = await fakeExporter("success", { FAKE_MARSDAWN_VERSION: "0.4.1", FAKE_MARSDAWN_ARGV: log })({ input });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /is marsdawn 0\.4\.1; this needs 0\.5\.0 or later/);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ['["--version"]']);
});

test("export: a file that doesn't report a version is refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marsdawn-mcp-"));
  const impostor = join(directory, "marsdawn");
  writeFileSync(impostor, "#!/bin/sh\nexit 1\n");
  chmodSync(impostor, 0o755);
  const result = await createExporter({ configuredPath: impostor, env: process.env, fallbacks: [] })({ input });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /didn't report a version/);
});

test("export: shell syntax in a path reaches marsdawn as one argument and never runs", async () => {
  // Guards the no-shell call: with `shell: true` on execFile, each of these runs its command.
  const directory = mkdtempSync(join(tmpdir(), "marsdawn-mcp-"));
  const log = join(directory, "argv");
  const inputs = [
    `${directory}/a.md; touch ${directory}/pwned-semicolon`,
    `${directory}/$(touch ${directory}/pwned-dollar).md`,
    `${directory}/\`touch ${directory}/pwned-backtick\`.md`,
    `${directory}/a.md && touch ${directory}/pwned-and`,
    `${directory}/a.md | touch ${directory}/pwned-pipe`,
  ];
  const exportMarkdown = fakeExporter("success", { FAKE_MARSDAWN_ARGV: log });
  for (const hostile of inputs) await exportMarkdown({ input: hostile });

  const pwned = readdirSync(directory).filter((name) => name.startsWith("pwned"));
  assert.deepEqual(pwned, [], `commands ran: ${pwned.join(", ")}`);
  const exports = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((args) => args[0] === "export");
  assert.deepEqual(exports.map((args) => args[1]), inputs);
  for (const args of exports) assert.deepEqual(args.slice(2), ["--json"]);
});

test("export: a bad argument is refused without running anything", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")), "argv");
  const result = await fakeExporter("success", { FAKE_MARSDAWN_ARGV: log })({ input: "plan.md" });
  assert.equal(result.isError, true);
  assert.throws(() => readFileSync(log), { code: "ENOENT" });
});

// --- open_in_marsdawn -------------------------------------------------------------------------

test("open arguments: an existing absolute path becomes `open <path> --json`", () => {
  const path = existingFile();
  assert.deepEqual(buildOpenArguments({ path }).args, ["open", path, "--json"]);
});

test("open arguments: a line is appended to the path as path:line", () => {
  const path = existingFile();
  assert.deepEqual(buildOpenArguments({ path, line: 12 }).args, ["open", `${path}:12`, "--json"]);
});

test("open arguments: background: true maps to --background", () => {
  const path = existingFile();
  assert.deepEqual(buildOpenArguments({ path, background: true }).args, ["open", path, "--json", "--background"]);
});

test("open arguments: background: false adds nothing", () => {
  const path = existingFile();
  assert.deepEqual(buildOpenArguments({ path, background: false }).args, ["open", path, "--json"]);
});

test("open arguments: a relative or tilde path is refused", () => {
  for (const bad of ["notes.md", "./notes.md", "~/notes.md", "", undefined, 42]) {
    assert.match(buildOpenArguments({ path: bad }).error, /absolute path/, `path ${String(bad)}`);
  }
});

test("open arguments: a path that doesn't exist is refused", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")), "missing.md");
  assert.match(buildOpenArguments({ path: missing }).error, /No such file/);
});

test("open arguments: a path that doesn't exist is checked with the injected fileExists", () => {
  const result = buildOpenArguments({ path: "/Users/me/notes/plan.md" }, { fileExists: () => true });
  assert.deepEqual(result.args, ["open", "/Users/me/notes/plan.md", "--json"]);
});

test("open arguments: line must be an integer of 1 or more", () => {
  const path = existingFile();
  for (const bad of [0, -1, 1.5, "1", true]) {
    assert.match(buildOpenArguments({ path, line: bad }).error, /integer of 1 or more/, `line ${String(bad)}`);
  }
});

test("open arguments: background must be a boolean", () => {
  const path = existingFile();
  assert.match(buildOpenArguments({ path, background: "yes" }).error, /`background` must be true or false/);
});

test("open: success returns the CLI's JSON as structuredContent", async () => {
  const path = existingFile();
  const result = await fakeOpener("success")({ path });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { ok: true, opened: [{ path }], app: "/Applications/MarsDawn.app" });
  assert.equal(result.content[0].text, `Opened ${path} in MarsDawn.`);
});

test("open: a line in the result is mentioned in the text", async () => {
  const path = existingFile();
  const result = await fakeOpener("success")({ path, line: 7 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.opened, [{ path, line: 7 }]);
  assert.equal(result.content[0].text, `Opened ${path} at line 7 in MarsDawn.`);
});

test("open: tolerates open.v1.json's bare-string opened shape too, at no real cost", async () => {
  const path = existingFile();
  const result = await fakeOpener("legacy_v1_shape")({ path });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, `Opened ${path} in MarsDawn.`);
});

test("open: the CLI is given exactly the built arguments", async () => {
  const path = existingFile();
  const log = join(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")), "argv");
  await fakeOpener("success", { FAKE_MARSDAWN_ARGV: log })({ path, line: 3, background: true });
  const runs = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(runs, [["--version"], ["open", `${path}:3`, "--json", "--background"]]);
});

test("open: exit code 3 becomes a clear \"not installed\" result, not a thrown error", async () => {
  const path = existingFile();
  const result = await fakeOpener("app_not_installed")({ path });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, /MarsDawn is not installed/);
  assert.match(result.content[0].text, /"error":"app_not_installed"/);
});

test("open: exit code 2 (input not found) is a clear result", async () => {
  const path = existingFile();
  const result = await fakeOpener("input_not_found")({ path });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, new RegExp(`No such file: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("open: a marsdawn older than 0.5.0 is refused before opening anything", async () => {
  const path = existingFile();
  const log = join(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")), "argv");
  const result = await fakeOpener("success", { FAKE_MARSDAWN_VERSION: "0.4.1", FAKE_MARSDAWN_ARGV: log })({ path });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /is marsdawn 0\.4\.1; this needs 0\.5\.0 or later/);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ['["--version"]']);
});

test("open: shell syntax in a path reaches marsdawn as one argument and never runs", async () => {
  // Guards the no-shell call: with `shell: true` on execFile, each of these runs its command.
  const directory = mkdtempSync(join(tmpdir(), "marsdawn-mcp-"));
  const log = join(directory, "argv");
  const hostileNames = [
    "a.md; touch pwned-semicolon",
    "$(touch pwned-dollar).md",
    "`touch pwned-backtick`.md",
    "a.md && touch pwned-and",
    "a.md | touch pwned-pipe",
  ];
  const paths = hostileNames.map((name) => {
    const path = join(directory, name);
    writeFileSync(path, "# Notes\n");
    return path;
  });
  const openInMarsdawn = fakeOpener("success", { FAKE_MARSDAWN_ARGV: log });
  for (const hostile of paths) await openInMarsdawn({ path: hostile });

  const pwned = readdirSync(directory).filter((name) => name.startsWith("pwned"));
  assert.deepEqual(pwned, [], `commands ran: ${pwned.join(", ")}`);
  const opens = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((args) => args[0] === "open");
  assert.deepEqual(opens.map((args) => args[1]), paths);
  for (const args of opens) assert.deepEqual(args.slice(2), ["--json"]);
});

test("open: a bad argument is refused without running anything", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")), "argv");
  const result = await fakeOpener("success", { FAKE_MARSDAWN_ARGV: log })({ path: "notes.md" });
  assert.equal(result.isError, true);
  assert.throws(() => readFileSync(log), { code: "ENOENT" });
});

test("guard: the fixture always wins over a real marsdawn elsewhere on PATH", async () => {
  // Every open/export test above resolves marsdawn through fakeOpener/fakeExporter, which put
  // `fixtures` first on PATH and disable the Homebrew fallbacks. This proves that placement is
  // what keeps a real, installed marsdawn from ever answering instead of the fake: even with real
  // system directories (and this machine's own Homebrew prefixes) also on PATH, the fixture that
  // comes first is still what's found. If it ever stopped winning, this fails loudly instead of
  // every test above quietly starting to exercise the real CLI (and, for `open`, the real app).
  const found = await locateMarsdawn({
    env: { PATH: `${fixtures}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin` },
    fallbacks: ["/opt/homebrew/bin", "/usr/local/bin"],
  });
  assert.equal(found.path, fake);
  assert.equal(found.path, join(fixtures, "marsdawn"));
});
