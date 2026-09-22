// The folders the tools may touch, and the checks every path argument passes before the CLI runs.
// Two sources, unioned: the directories the server was started with, and the client's MCP roots.
// Everything here is pure but for `fs`, which is injected so the checks can be tested for real.

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The filesystem the checks use: `realpath.native` and `lstat`, both synchronous. */
export const nodeFs = {
  realpath: (path) => realpathSync.native(path),
  lstat: (path) => lstatSync(path),
};

/** What to say when neither a configured folder nor a root leaves anything to work in. */
export const NOTHING_ALLOWED = [
  "No folder is allowed yet, so nothing can be read or written.",
  'Set the extension\'s "Allowed folders" setting,',
  "or start the server with the folders as arguments (node server/index.js /Users/me/Documents),",
  "or connect from a client that offers MCP roots.",
].join(" ");

/** R0's refusal, naming the argument it is about. */
export function normalFormError(name) {
  return `\`${name}\` must be a plain absolute path without \`.\` or \`..\` components.`;
}

/**
 * The refusal for anything outside the allowed folders, the same for a path that exists and one
 * that does not, so neither tool says whether a file outside is there. It names the folders so the
 * agent can pick a valid path instead of retrying blindly.
 */
export function outsideError(name, allowed) {
  return `\`${name}\` must be inside an allowed folder (${allowed.join(", ")}). Nothing outside it is read or written.`;
}

/**
 * R0: the argument is a string, holds no NUL byte, is absolute, and is its own normal form — no
 * `.`, `..` or empty component and no trailing slash. This is what lets the server hand the CLI
 * the very string it checked.
 */
export function normalForm(arg) {
  return typeof arg === "string" && !arg.includes("\0") && isAbsolute(arg) && resolve(arg) === arg;
}

/** Whether a realpath'd `p` is `dir` itself or below it. `dir` is never `/`. */
export function inside(p, dir) {
  return p === dir || p.startsWith(dir + sep);
}

function isInsideAny(p, allowed) {
  return allowed.some((dir) => inside(p, dir));
}

/**
 * The allowed folders from the server's positional arguments. Empty, whitespace-only and unfilled
 * `${...}` placeholders are ignored; a relative argument is refused; one that doesn't resolve to an
 * existing directory, or resolves to `/`, is dropped; the rest are realpath'd and deduplicated.
 * Returns `{ directories, notes }`, the notes being lines for stderr.
 */
export function allowedDirectoriesFrom(argv, fs = nodeFs) {
  const directories = [];
  const notes = [];
  for (const arg of argv ?? []) {
    if (typeof arg !== "string") continue;
    const trimmed = arg.trim();
    if (trimmed === "" || trimmed.includes("${")) continue;
    if (!isAbsolute(trimmed)) {
      notes.push(`refused the allowed folder ${trimmed}: it must be an absolute path.`);
      continue;
    }
    let resolved;
    try {
      resolved = fs.realpath(trimmed);
      if (!fs.lstat(resolved).isDirectory()) throw new Error("not a directory");
    } catch {
      notes.push(`dropped the allowed folder ${trimmed}: it isn't an existing directory.`);
      continue;
    }
    if (resolved === sep) {
      notes.push(`dropped the allowed folder ${trimmed}: the whole filesystem can't be an allowed folder.`);
      continue;
    }
    if (!directories.includes(resolved)) directories.push(resolved);
  }
  return { directories, notes };
}

/**
 * The allowed folders from the client's MCP roots. A URI that isn't a plain local `file:` path
 * (another host, an encoded NUL, anything that won't resolve) is ignored, and `/` is dropped. A
 * root that names a file stays in the list and refuses everything, since no path's parent is
 * inside a file.
 */
export function rootsToDirectories(roots, fs = nodeFs) {
  const directories = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    const uri = typeof root === "string" ? root : root?.uri;
    if (typeof uri !== "string") continue;
    let resolved;
    try {
      resolved = fs.realpath(fileURLToPath(uri));
    } catch {
      continue;
    }
    if (resolved === sep) continue;
    if (!directories.includes(resolved)) directories.push(resolved);
  }
  return directories;
}

/**
 * R0, R2, R3, R4 for the file a tool reads. Returns `{ path }` — the very string that was checked,
 * for the CLI — or `{ error }`. A path that doesn't exist inside an allowed folder is passed
 * through, so the CLI reports `input_not_found` with its own next step.
 */
export function checkReadable(path, allowed, fs = nodeFs, { name = "input", folderHint = "" } = {}) {
  if (!Array.isArray(allowed) || allowed.length === 0) return { error: NOTHING_ALLOWED };
  if (!normalForm(path)) return { error: normalFormError(name) };

  // R2: the directory the CLI writes the default PDF into and reads images from.
  let parent;
  try {
    parent = fs.realpath(dirname(path));
  } catch {
    return { error: outsideError(name, allowed) };
  }
  if (!isInsideAny(parent, allowed)) return { error: outsideError(name, allowed) };

  // R3: the file itself, so a symlink that leaves the tree is refused. realpath says ENOENT both
  // for a missing file and for a symlink whose target can't be resolved; only a missing plain
  // entry goes on to the CLI. A dangling symlink gets the outside refusal, word for word, so the
  // answer says nothing about where it points or whether anything is there.
  let resolved;
  try {
    resolved = fs.realpath(path);
  } catch (error) {
    if (error?.code !== "ENOENT") return { error: outsideError(name, allowed) };
    try {
      fs.lstat(join(parent, basename(path)));
    } catch (entryError) {
      if (entryError?.code === "ENOENT") return { path };
    }
    return { error: outsideError(name, allowed) };
  }
  if (!isInsideAny(resolved, allowed)) return { error: outsideError(name, allowed) };

  // R4: a directory or a FIFO inside an allowed folder is refused here, not by the CLI.
  let stats;
  try {
    stats = fs.lstat(resolved);
  } catch {
    return { error: outsideError(name, allowed) };
  }
  if (stats.isDirectory()) {
    return { error: `\`${name}\` must be a file, not a folder: ${path}.${folderHint}` };
  }
  if (!stats.isFile()) return { error: `\`${name}\` must be a regular file: ${path}.` };
  return { path };
}

/**
 * R0, W1, W2, W4 for the file export writes. Returns `{ path }` or `{ error }`. The destination is
 * checked as the realpath'd parent plus the basename, which R0 guarantees is a plain name, so the
 * check can't land anywhere the CLI won't write.
 */
export function checkWritable(path, allowed, fs = nodeFs, { name = "output" } = {}) {
  if (!Array.isArray(allowed) || allowed.length === 0) return { error: NOTHING_ALLOWED };
  if (!normalForm(path)) return { error: normalFormError(name) };

  // W1: the parent must resolve inside an allowed folder.
  let parent;
  try {
    parent = fs.realpath(dirname(path));
  } catch {
    return { error: outsideError(name, allowed) };
  }
  if (!isInsideAny(parent, allowed)) return { error: outsideError(name, allowed) };

  // W2: a new PDF is fine; a symlink, a folder or anything else in the way is not. A hard link is
  // allowed and harmless: the CLI renders beside the destination and replaces the directory entry,
  // so the other link keeps its bytes.
  const destination = join(parent, basename(path));
  try {
    const stats = fs.lstat(destination);
    if (stats.isSymbolicLink()) {
      return { error: `\`${name}\` is a symbolic link, and marsdawn-mcp won't write through a symlink: ${path}.` };
    }
    if (!stats.isFile()) return { error: `\`${name}\` must be a regular file: ${path}.` };
  } catch (error) {
    if (error?.code !== "ENOENT") return { error: `\`${name}\` can't be written: ${path}.` };
  }

  // W4: PDFs only, so nothing else inside an allowed folder is ever a target.
  if (!basename(path).toLowerCase().endsWith(".pdf")) return { error: `\`${name}\` must name a .pdf file.` };
  return { path };
}

/** Where the CLI would put the PDF for `path`: its last extension replaced with `.pdf`. */
export function defaultOutputFor(path) {
  const base = basename(path);
  const extension = extname(base);
  const stem = extension === "" ? base : base.slice(0, -extension.length);
  return join(dirname(path), `${stem}.pdf`);
}

/**
 * Both of export's paths: the input is checked, the default output is filled in when `output` is
 * absent, and the destination is checked either way. Returns `{ output }`, the path to pass the
 * CLI as `--output`, or `{ error }`.
 */
export function checkExportPaths({ input, output }, allowed, fs = nodeFs) {
  const readable = checkReadable(input, allowed, fs, { name: "input" });
  if (readable.error) return { error: readable.error };
  const destination = output === undefined ? defaultOutputFor(readable.path) : output;
  const writable = checkWritable(destination, allowed, fs, { name: "output" });
  if (writable.error) return { error: writable.error };
  return { output: writable.path };
}

/** Open's one path, checked exactly as export's input is. */
export function checkOpenPath(path, allowed, fs = nodeFs) {
  return checkReadable(path, allowed, fs, {
    name: "path",
    folderHint: " Opening a folder isn't supported yet; it arrives with MarsDawn 1.1.",
  });
}
