// Runs the `marsdawn` command-line tool and turns its `--json` output into tool results.
// Everything the tool reports comes from the CLI; this module adds no rendering of its own.

import { execFile } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

const schemaDirectory = new URL("../schemas/", import.meta.url);

/** A schema as the site publishes it, byte for byte (see scripts/check-schemas.js). */
export function loadSchema(name) {
  return JSON.parse(readFileSync(new URL(name, schemaDirectory), "utf8"));
}

export const exportSchema = loadSchema("export.v1.json");
export const openSchema = loadSchema("open.v2.json");
export const errorSchema = loadSchema("error.v1.json");

export const THEMES = exportSchema.properties.theme.enum;
export const PAPERS = exportSchema.properties.paper.enum;

/** The first release whose `--json` output the published schemas describe. */
export const MINIMUM_VERSION = "0.5.0";

/** Where Homebrew puts `marsdawn` on Apple silicon and on Intel, for when PATH doesn't say. */
export const FALLBACK_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"];

export const TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export const INSTALL_HINT =
  "Install it with `brew install redtear1115/tap/marsdawn`, or set its path in the extension's settings.";

/** What to do next for each failure kind in error.v1.json. */
export const NEXT_STEPS = {
  input_not_found: "Check that `input` is the absolute path of an existing Markdown file saved as UTF-8.",
  app_not_installed: "Only `marsdawn open` needs the MarsDawn app; export works without it.",
  output_exists: "Pass `force: true` to replace it, or choose another `output` path.",
  export_failed: "Nothing was written. The message says why rendering failed.",
};

async function isExecutableFile(path) {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A configured path the bundle host left unfilled arrives empty, or as the literal
 * `${user_config.marsdawn_path}` placeholder; both mean "not configured".
 */
export function configuredPathFrom(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("${")) return undefined;
  return trimmed;
}

/**
 * Finds `marsdawn`: the configured path, then PATH, then Homebrew's two prefixes.
 * Returns `{ path }`, or `{ error }` with a message for the agent.
 */
export async function locateMarsdawn({ configuredPath, env = process.env, fallbacks = FALLBACK_DIRECTORIES } = {}) {
  if (configuredPath !== undefined) {
    if (await isExecutableFile(configuredPath)) return { path: configuredPath };
    return { error: `The configured marsdawn path, ${configuredPath}, isn't an executable file. ${INSTALL_HINT}` };
  }
  const directories = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...fallbacks];
  for (const directory of directories) {
    const candidate = join(directory, "marsdawn");
    if (await isExecutableFile(candidate)) return { path: candidate };
  }
  return { error: `marsdawn isn't installed. ${INSTALL_HINT}` };
}

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return match ? match.slice(1, 4).map(Number) : null;
}

export function isAtLeast(version, minimum) {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

/** Runs a file with an argument list and no shell. Never rejects. */
export function runFile(file, args, { env = process.env, timeoutMs = TIMEOUT_MS, maxBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: timeoutMs, maxBuffer: maxBytes, killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout, stderr) => {
        const result = { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
        if (!error) return resolve(result);
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ ...result, overflowBytes: maxBytes });
        if (error.killed) return resolve({ ...result, timedOutAfterMs: timeoutMs });
        if (typeof error.code === "number") return resolve({ ...result, exitCode: error.code });
        resolve({ ...result, spawnError: error.message });
      },
    );
  });
}

function toolError(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Checks the tool's arguments and builds the CLI's. Returns `{ args }` or `{ error }`. */
export function buildExportArguments(input) {
  const { input: file, output, theme, paper, force, allowRemoteImages } = input ?? {};
  if (typeof file !== "string" || !isAbsolute(file)) {
    return { error: "`input` must be an absolute path, such as /Users/me/notes/plan.md." };
  }
  const args = ["export", file, "--json"];
  if (output !== undefined) {
    if (typeof output !== "string" || !isAbsolute(output)) {
      return { error: "`output` must be an absolute path, such as /Users/me/notes/plan.pdf." };
    }
    args.push("--output", output);
  }
  if (theme !== undefined) {
    if (!THEMES.includes(theme)) return { error: `\`theme\` must be one of ${THEMES.join(", ")}.` };
    args.push("--theme", theme);
  }
  if (paper !== undefined) {
    if (!PAPERS.includes(paper)) return { error: `\`paper\` must be one of ${PAPERS.join(", ")}.` };
    args.push("--paper", paper);
  }
  for (const [name, value, flag] of [
    ["force", force, "--force"],
    ["allowRemoteImages", allowRemoteImages, "--allow-remote-images"],
  ]) {
    if (value === undefined) continue;
    if (typeof value !== "boolean") return { error: `\`${name}\` must be true or false.` };
    if (value) args.push(flag);
  }
  return { args };
}

/**
 * Checks the tool's arguments and builds the CLI's. Returns `{ args }` or `{ error }`.
 *
 * No `folder`: the launch build's `marsdawn open --folder` answers with an error dialog in the
 * app (mars-dawn#165); folders return in app 1.1, once the site publishes open.v3.json for them.
 */
export function buildOpenArguments(input, { fileExists = (path) => existsSync(path) } = {}) {
  const { path, line, background } = input ?? {};
  if (typeof path !== "string" || !isAbsolute(path)) {
    return { error: "`path` must be an absolute path, such as /Users/me/notes/plan.md." };
  }
  if (!fileExists(path)) {
    return { error: `No such file: ${path}` };
  }
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
    return { error: "`line` must be an integer of 1 or more." };
  }
  const target = line === undefined ? path : `${path}:${line}`;
  const args = ["open", target, "--json"];
  if (background !== undefined) {
    if (typeof background !== "boolean") return { error: "`background` must be true or false." };
    if (background) args.push("--background");
  }
  return { args };
}

function lastJSONLine(stdout) {
  const line = stdout.split("\n").map((part) => part.trim()).filter(Boolean).at(-1);
  if (line === undefined) return undefined;
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The start of some output, for an error message: at most 10 lines and 2,000 characters. */
function firstLines(text, count = 10, limit = 2000) {
  const lines = text.split("\n").filter((line) => line.trim() !== "").slice(0, count).join("\n");
  return lines.length > limit ? `${lines.slice(0, limit)}…` : lines;
}

function unexpected(what, result) {
  const detail = firstLines(result.stderr) || firstLines(result.stdout) || "(no output)";
  return toolError(`marsdawn ${what} (exit code ${result.exitCode}):\n${detail}`);
}

/** Turns one run of `marsdawn export --json` into a tool result. */
export function interpretExport(result) {
  if (result.spawnError) return toolError(`marsdawn couldn't be started: ${result.spawnError}`);
  if (result.timedOutAfterMs) {
    return toolError(`marsdawn didn't finish within ${result.timedOutAfterMs / 1000} seconds and was stopped.`);
  }
  if (result.overflowBytes) {
    return toolError(`marsdawn printed more than ${result.overflowBytes} bytes, which isn't a --json result.`);
  }

  const json = lastJSONLine(result.stdout);
  if (result.exitCode === 0) {
    const complete = json?.ok === true && exportSchema.required.every((key) => key in json);
    if (!complete) return unexpected("succeeded but didn't print a --json result", result);
    const pages = `${json.pages} ${json.pages === 1 ? "page" : "pages"}`;
    const lines = [`Exported ${json.output} (${pages}, theme ${json.theme}, paper ${json.paper}).`];
    for (const message of json.diagramErrors) lines.push(`A diagram didn't render: ${message}`);
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: json };
  }
  if (json?.ok === false && errorSchema.properties.error.enum.includes(json.error)) {
    const next = NEXT_STEPS[json.error];
    return toolError(`${json.message} ${next}\n${JSON.stringify(json)}`);
  }
  return unexpected("failed", result);
}

/**
 * One entry of `open.v2.json`'s `opened`, as a path and the line it was asked to land on. Also
 * accepts a bare string (open.v1.json's shape), which costs nothing and reads the same either way.
 */
function openedEntry(entry) {
  if (typeof entry === "string") return { path: entry, line: undefined };
  return { path: entry?.path, line: entry?.line };
}

/** Turns one run of `marsdawn open --json` into a tool result. */
export function interpretOpen(result) {
  if (result.spawnError) return toolError(`marsdawn couldn't be started: ${result.spawnError}`);
  if (result.timedOutAfterMs) {
    return toolError(`marsdawn didn't finish within ${result.timedOutAfterMs / 1000} seconds and was stopped.`);
  }
  if (result.overflowBytes) {
    return toolError(`marsdawn printed more than ${result.overflowBytes} bytes, which isn't a --json result.`);
  }

  const json = lastJSONLine(result.stdout);
  if (result.exitCode === 0) {
    const complete = json?.ok === true && openSchema.required.every((key) => key in json);
    if (!complete) return unexpected("succeeded but didn't print a --json result", result);
    const { path, line } = openedEntry(json.opened[0]);
    const text = line === undefined ? `Opened ${path} in MarsDawn.` : `Opened ${path} at line ${line} in MarsDawn.`;
    return { content: [{ type: "text", text }], structuredContent: json };
  }
  if (json?.ok === false && errorSchema.properties.error.enum.includes(json.error)) {
    const next = NEXT_STEPS[json.error];
    return toolError(`${json.message} ${next}\n${JSON.stringify(json)}`);
  }
  return unexpected("failed", result);
}

/**
 * Locates and version-checks `marsdawn` once, caching the result after success so a missing tool
 * is looked for again next call. Shared by `createExporter` and `createOpener`.
 */
function createLocator({ configuredPath, env = process.env, fallbacks, timeoutMs, maxBytes } = {}) {
  let located;
  const minimum = parseVersion(MINIMUM_VERSION);

  return async function locateChecked() {
    if (located) return located;
    const found = await locateMarsdawn({ configuredPath, env, fallbacks });
    if (found.error) return found;
    const version = await runFile(found.path, ["--version"], { env, timeoutMs, maxBytes });
    const parsed = parseVersion(version.stdout);
    if (version.exitCode !== 0 || !parsed) {
      return { error: `${found.path} didn't report a version, so it may not be marsdawn. ${INSTALL_HINT}` };
    }
    if (!isAtLeast(parsed, minimum)) {
      return {
        error: `${found.path} is marsdawn ${parsed.join(".")}; this needs ${MINIMUM_VERSION} or later. Update it with \`brew upgrade marsdawn\`.`,
      };
    }
    located = found;
    return located;
  };
}

/**
 * The export tool, bound to one way of finding `marsdawn`. The located path and its version
 * check are cached after the first success, so a missing tool is looked for again next call.
 */
export function createExporter({ configuredPath, env = process.env, fallbacks, timeoutMs, maxBytes } = {}) {
  const locateChecked = createLocator({ configuredPath, env, fallbacks, timeoutMs, maxBytes });
  return async function exportMarkdown(input) {
    const built = buildExportArguments(input);
    if (built.error) return toolError(built.error);
    const found = await locateChecked();
    if (found.error) return toolError(found.error);
    return interpretExport(await runFile(found.path, built.args, { env, timeoutMs, maxBytes }));
  };
}

/**
 * The open tool, bound to one way of finding `marsdawn`. The located path and its version check
 * are cached after the first success, so a missing tool is looked for again next call.
 */
export function createOpener({ configuredPath, env = process.env, fallbacks, timeoutMs, maxBytes } = {}) {
  const locateChecked = createLocator({ configuredPath, env, fallbacks, timeoutMs, maxBytes });
  return async function openInMarsdawn(input) {
    const built = buildOpenArguments(input);
    if (built.error) return toolError(built.error);
    const found = await locateChecked();
    if (found.error) return toolError(found.error);
    return interpretOpen(await runFile(found.path, built.args, { env, timeoutMs, maxBytes }));
  };
}
