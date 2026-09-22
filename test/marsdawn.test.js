import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_LINE,
  NEXT_STEPS,
  OPEN_NEXT_STEPS,
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

/** A folder the tools are allowed to work in, spelled the way `realpath.native` returns it. */
function temporaryTree() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), "marsdawn-mcp-")));
}

const tree = temporaryTree();
const allowed = [tree];
const allowedProvider = async () => allowed;

/** An exporter that finds the fake through PATH alone, with Homebrew's prefixes switched off. */
function fakeExporter(mode, extraEnv = {}, options = {}) {
  const env = { ...process.env, PATH: `${fixtures}:${process.env.PATH}`, FAKE_MARSDAWN_MODE: mode, ...extraEnv };
  return createExporter({ env, fallbacks: [], allowed: allowedProvider, ...options });
}

/** An opener that finds the fake through PATH alone, with Homebrew's prefixes switched off. */
function fakeOpener(mode, extraEnv = {}, options = {}) {
  const env = { ...process.env, PATH: `${fixtures}:${process.env.PATH}`, FAKE_MARSDAWN_MODE: mode, ...extraEnv };
  return createOpener({ env, fallbacks: [], allowed: allowedProvider, ...options });
}

const input = join(tree, "plan.md");
const inputPdf = join(tree, "plan.pdf");
writeFileSync(input, "# Plan\n");

let serial = 0;

/** A real file inside the allowed tree, since every path argument is confined to it. */
function existingFile() {
  serial += 1;
  const path = join(tree, `notes-${serial}.md`);
  writeFileSync(path, "# Notes\n");
  return path;
}

/** A real directory inside the allowed tree, for the "path must be a file, not a folder" checks. */
function existingDirectory() {
  serial += 1;
  const path = join(tree, `folder-${serial}`);
  mkdirSync(path);
  return path;
}

/** Names that run a command of their own if anything ever passes a path through a shell. */
const HOSTILE_NAMES = [
  "a.md; touch pwned-semicolon",
  "$(touch pwned-dollar).md",
  "`touch pwned-backtick`.md",
  "a.md && touch pwned-and",
  "a.md | touch pwned-pipe",
];

/** A regular expression's worth of escaping for a real path. */
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** No `pwned-` file anywhere a shell could have put one: the folder, or this process's own cwd. */
function assertNothingRan(directory) {
  for (const place of [directory, process.cwd()]) {
    const pwned = readdirSync(place).filter((name) => name.startsWith("pwned"));
    assert.deepEqual(pwned, [], `commands ran in ${place}: ${pwned.join(", ")}`);
  }
}

test("the exit-code table has a next step for every error kind the schema allows", () => {
  assert.deepEqual(Object.keys(NEXT_STEPS).sort(), [...errorSchema.properties.error.enum].sort());
});

test("open's exit-code table also has a next step for every error kind the schema allows", () => {
  assert.deepEqual(Object.keys(OPEN_NEXT_STEPS).sort(), [...errorSchema.properties.error.enum].sort());
});

test("arguments: an absolute input becomes `export <input> --json --output <default>`", () => {
  // W0: the destination the server checked is the one the CLI is told to write, never one the
  // CLI derives for itself from the input path.
  assert.deepEqual(buildExportArguments({ input }, { allowed }).args, [
    "export", input, "--json", "--output", inputPdf,
  ]);
});

test("arguments: every option maps to its flag", () => {
  const output = join(tree, "out.pdf");
  const { args } = buildExportArguments({
    input,
    output,
    theme: "vivid",
    paper: "letter",
    force: true,
    allowRemoteImages: true,
  }, { allowed });
  assert.deepEqual(args, [
    "export", input, "--json",
    "--output", output,
    "--theme", "vivid",
    "--paper", "letter",
    "--force",
    "--allow-remote-images",
  ]);
});

test("arguments: false flags add nothing", () => {
  assert.deepEqual(buildExportArguments({ input, force: false, allowRemoteImages: false }, { allowed }).args, [
    "export", input, "--json", "--output", inputPdf,
  ]);
});

test("arguments: relative, tilde and option-like paths are refused", () => {
  for (const bad of ["plan.md", "./plan.md", "~/plan.md", "--force", "-o", "", undefined, 42]) {
    assert.match(buildExportArguments({ input: bad }, { allowed }).error, /absolute path/, `input ${String(bad)}`);
  }
  assert.match(
    buildExportArguments({ input, output: "out.pdf" }, { allowed }).error,
    /`output` must be a plain absolute path/,
  );
});

test("arguments: values outside the schema's enums are refused", () => {
  assert.match(buildExportArguments({ input, theme: "dark" }, { allowed }).error, /dawn, classic, modern, vivid/);
  assert.match(buildExportArguments({ input, paper: "A4" }, { allowed }).error, /a4, letter/);
  assert.match(buildExportArguments({ input, force: "yes" }, { allowed }).error, /`force` must be true or false/);
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
    output: inputPdf,
    pages: 1,
    paper: "a4",
    theme: "classic",
  });
  assert.equal(result.content[0].text, `Exported ${inputPdf} (1 page, theme classic, paper a4).`);
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
  assert.deepEqual(runs, [
    ["--version"],
    ["export", input, "--json", "--output", inputPdf, "--paper", "letter", "--force"],
  ]);
});

for (const [mode, kind, pattern] of [
  ["input_not_found", "input_not_found", new RegExp(`No such file: ${escaped(input)}`)],
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
  const log = join(temporaryTree(), "argv");
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
  const result = await createExporter({
    configuredPath: impostor,
    env: process.env,
    fallbacks: [],
    allowed: allowedProvider,
  })({ input });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /didn't report a version/);
});

test("export: shell syntax in a path reaches marsdawn as one argument and never runs", async () => {
  // Guards the no-shell call: with `shell: true` on execFile, each of these runs its command.
  // The names stay inside the allowed tree, so confinement doesn't refuse them first; a shell that
  // ran one would create the file in this process's working directory, which is checked too.
  const log = join(temporaryTree(), "argv");
  const inputs = HOSTILE_NAMES.map((name) => join(tree, name));
  const exportMarkdown = fakeExporter("success", { FAKE_MARSDAWN_ARGV: log });
  for (const hostile of inputs) await exportMarkdown({ input: hostile });

  assertNothingRan(tree);
  const exports = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((args) => args[0] === "export");
  assert.deepEqual(exports.map((args) => args[1]), inputs);
  for (const args of exports) assert.deepEqual(args.slice(2, 4), ["--json", "--output"]);
});

test("export: a bad argument is refused without running anything", async () => {
  const log = join(temporaryTree(), "argv");
  const result = await fakeExporter("success", { FAKE_MARSDAWN_ARGV: log })({ input: "plan.md" });
  assert.equal(result.isError, true);
  assert.throws(() => readFileSync(log), { code: "ENOENT" });
});

// --- open_in_marsdawn -------------------------------------------------------------------------

test("open arguments: an existing absolute path becomes `open <path> --json`", () => {
  const path = existingFile();
  assert.deepEqual(buildOpenArguments({ path }, { allowed }).args, ["open", path, "--json"]);
});

test("open arguments: a line is appended to the path as path:line", () => {
  const path = existingFile();
  assert.deepEqual(buildOpenArguments({ path, line: 12 }, { allowed }).args, ["open", `${path}:12`, "--json"]);
});

test("open arguments: background: true maps to --background", () => {
  const path = existingFile();
  assert.deepEqual(buildOpenArguments({ path, background: true }, { allowed }).args, [
    "open", path, "--json", "--background",
  ]);
});

test("open arguments: background: false adds nothing", () => {
  const path = existingFile();
  assert.deepEqual(buildOpenArguments({ path, background: false }, { allowed }).args, ["open", path, "--json"]);
});

test("open arguments: a relative or tilde path is refused", () => {
  for (const bad of ["notes.md", "./notes.md", "~/notes.md", "", undefined, 42]) {
    assert.match(buildOpenArguments({ path: bad }, { allowed }).error, /absolute path/, `path ${String(bad)}`);
  }
});

test("open arguments: a path that doesn't exist is refused", () => {
  const missing = join(tree, "missing.md");
  assert.match(buildOpenArguments({ path: missing }, { allowed }).error, /No such file/);
});

test("open arguments: a path that doesn't exist is checked with the injected readStat", () => {
  const ghost = join(tree, "ghost.md");
  const result = buildOpenArguments({ path: ghost }, { allowed, readStat: () => ({ isFile: () => true }) });
  assert.deepEqual(result.args, ["open", ghost, "--json"]);
});

test("open arguments: a folder is refused, not sent to the CLI", () => {
  const directory = existingDirectory();
  const { error } = buildOpenArguments({ path: directory }, { allowed });
  assert.match(error, /`path` must be a file, not a folder/);
  assert.match(error, /MarsDawn 1\.1/);
});

test("open: a folder is refused before the CLI is even run", async () => {
  const directory = existingDirectory();
  const log = join(temporaryTree(), "argv");
  const result = await fakeOpener("success", { FAKE_MARSDAWN_ARGV: log })({ path: directory });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must be a file, not a folder/);
  assert.throws(() => readFileSync(log), { code: "ENOENT" }, "the fixture (the CLI stand-in) must not have run");
});

test("open arguments: line must be an integer between 1 and MAX_LINE", () => {
  const path = existingFile();
  for (const bad of [0, -1, 1.5, "1", true, MAX_LINE + 1]) {
    assert.match(
      buildOpenArguments({ path, line: bad }, { allowed }).error,
      /integer between 1 and 999999999/,
      `line ${String(bad)}`,
    );
  }
  assert.equal(buildOpenArguments({ path, line: MAX_LINE }, { allowed }).error, undefined, "the maximum itself is allowed");
});

test("open arguments: background must be a boolean", () => {
  const path = existingFile();
  assert.match(buildOpenArguments({ path, background: "yes" }, { allowed }).error, /`background` must be true or false/);
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
  const log = join(temporaryTree(), "argv");
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

test("open: exit code 2 (input not found) is a clear result, with a next step naming `path`", async () => {
  const path = existingFile();
  const result = await fakeOpener("input_not_found")({ path });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, new RegExp(`No such file: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result.content[0].text, /Check that `path` is the absolute path/);
  assert.doesNotMatch(result.content[0].text, /Check that `input`/);
});

test("open: a marsdawn older than 0.5.0 is refused before opening anything", async () => {
  const path = existingFile();
  const log = join(temporaryTree(), "argv");
  const result = await fakeOpener("success", { FAKE_MARSDAWN_VERSION: "0.4.1", FAKE_MARSDAWN_ARGV: log })({ path });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /is marsdawn 0\.4\.1; this needs 0\.5\.0 or later/);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ['["--version"]']);
});

test("open: shell syntax in a path reaches marsdawn as one argument and never runs", async () => {
  // Guards the no-shell call: with `shell: true` on execFile, each of these runs its command.
  const directory = temporaryTree();
  const log = join(directory, "argv");
  const paths = HOSTILE_NAMES.map((name) => {
    const path = join(directory, name);
    writeFileSync(path, "# Notes\n");
    return path;
  });
  const openInMarsdawn = fakeOpener("success", { FAKE_MARSDAWN_ARGV: log }, { allowed: async () => [directory] });
  for (const hostile of paths) await openInMarsdawn({ path: hostile });

  assertNothingRan(directory);
  const opens = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((args) => args[0] === "open");
  assert.deepEqual(opens.map((args) => args[1]), paths);
  for (const args of opens) assert.deepEqual(args.slice(2), ["--json"]);
});

test("open: a bad argument is refused without running anything", async () => {
  const log = join(temporaryTree(), "argv");
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
