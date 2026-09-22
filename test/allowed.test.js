// U0-U8: the confinement rules, against an injected filesystem that records every call it is
// given, so "refused without touching the disk" is something a test can actually assert.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  NOTHING_ALLOWED,
  allowedDirectoriesFrom,
  checkExportPaths,
  checkOpenPath,
  checkReadable,
  checkWritable,
  defaultOutputFor,
  inside,
  normalForm,
  rootsToDirectories,
} from "../server/allowed.js";

const enoent = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

/**
 * A filesystem of two lookup tables: `realpath` maps a path to what it resolves to (a string, or
 * an Error to throw), `lstat` maps a resolved path to "file", "dir", "link" or "fifo". Anything
 * not in a table is ENOENT. Every call is appended to `calls`, and a NUL byte throws the way the
 * real `fs` does, so dropping the server's own NUL check still shows up as recorded calls.
 */
function fakeFs({ realpath = {}, lstat = {} } = {}) {
  const calls = [];
  const look = (table, path, kind) => {
    calls.push(`${kind} ${path}`);
    if (typeof path === "string" && path.includes("\0")) {
      throw Object.assign(new TypeError(`${kind}: the argument must be a string without null bytes`), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    if (!Object.prototype.hasOwnProperty.call(table, path)) throw enoent(path);
    const entry = table[path];
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return {
    calls,
    realpath: (path) => look(realpath, path, "realpath"),
    lstat: (path) => {
      const type = look(lstat, path, "lstat");
      return {
        isFile: () => type === "file",
        isDirectory: () => type === "dir",
        isSymbolicLink: () => type === "link",
      };
    },
  };
}

const ALLOWED = ["/allowed"];

/** /allowed and /outside, with the symlinks the worked cases in the plan's §3 name. */
function baseTree() {
  return {
    realpath: {
      "/allowed": "/allowed",
      "/allowed/plan.md": "/allowed/plan.md",
      "/allowed/y.md": "/allowed/y.md",
      "/allowed/sub": "/allowed/sub",
      "/allowed/pipe": "/allowed/pipe",
      "/allowed/link.md": "/outside/real.md",
      "/allowed/linkdir": "/outside",
      "/allowed/linkdir/x.md": "/allowed/y.md",
      "/outside": "/outside",
      "/outside/real.md": "/outside/real.md",
      "/outside/link.md": "/allowed/y.md",
    },
    lstat: {
      "/allowed": "dir",
      "/allowed/plan.md": "file",
      "/allowed/y.md": "file",
      "/allowed/sub": "dir",
      "/allowed/pipe": "fifo",
      "/outside": "dir",
      "/outside/real.md": "file",
    },
  };
}

// --- U0: R0, the normal form -------------------------------------------------------------------

test("U0: a path that isn't its own normal form is refused before any filesystem call", () => {
  for (const bad of ["/a/./x", "/a/../x", "/a//x", "/a/x/", "plan.md", "./plan.md", "~/x", "", 42, undefined]) {
    const fs = fakeFs(baseTree());
    const { error } = checkReadable(bad, ALLOWED, fs);
    assert.match(error, /`input` must be a plain absolute path without `\.` or `\.\.` components\./, String(bad));
    assert.deepEqual(fs.calls, [], `${String(bad)} touched the filesystem`);
  }
  assert.equal(normalForm("/a/x"), true);
  const fs = fakeFs(baseTree());
  assert.deepEqual(checkReadable("/allowed/plan.md", ALLOWED, fs), { path: "/allowed/plan.md" });
});

test("U0: the same rule, and the same wording, for `output` and `path`", () => {
  assert.match(checkWritable("/a/../x.pdf", ALLOWED, fakeFs(baseTree())).error, /`output` must be a plain absolute path/);
  assert.match(checkOpenPath("/a/./x.md", ALLOWED, fakeFs(baseTree())).error, /`path` must be a plain absolute path/);
});

// --- U1: containment ---------------------------------------------------------------------------

test("U1: inside is allowed, outside is refused, and a folder whose name only starts the same is outside", () => {
  const documents = ["/Users/me/Documents"];
  const fs = fakeFs({
    realpath: {
      "/Users/me/Documents": "/Users/me/Documents",
      "/Users/me/Documents/x.md": "/Users/me/Documents/x.md",
      "/Users/me/Documents2": "/Users/me/Documents2",
      "/Users/me/Documents2/x.md": "/Users/me/Documents2/x.md",
      "/Users/me/Secrets": "/Users/me/Secrets",
      "/Users/me/Secrets/x.md": "/Users/me/Secrets/x.md",
    },
    lstat: {
      "/Users/me/Documents/x.md": "file",
      "/Users/me/Documents2/x.md": "file",
      "/Users/me/Secrets/x.md": "file",
    },
  });
  assert.deepEqual(checkReadable("/Users/me/Documents/x.md", documents, fs), { path: "/Users/me/Documents/x.md" });
  assert.match(checkReadable("/Users/me/Secrets/x.md", documents, fs).error, /must be inside an allowed folder/);
  assert.match(
    checkReadable("/Users/me/Documents2/x.md", documents, fs).error,
    /must be inside an allowed folder \(\/Users\/me\/Documents\)/,
  );
  assert.equal(inside("/Users/me/Documents2", "/Users/me/Documents"), false);
  assert.equal(inside("/Users/me/Documents", "/Users/me/Documents"), true);
  assert.equal(inside("/Users/me/Documents/a/b", "/Users/me/Documents"), true);
});

// --- U2: the two symlink cases -----------------------------------------------------------------

test("U2: a file inside that is a symlink out is refused (R3)", () => {
  const fs = fakeFs(baseTree());
  assert.match(checkReadable("/allowed/link.md", ALLOWED, fs).error, /must be inside an allowed folder/);
});

test("U2: a symlinked directory whose file resolves back inside is refused, and only R2 can refuse it", () => {
  // /allowed/linkdir -> /outside, and /outside/x.md -> /allowed/y.md: R3's realpath lands inside,
  // so the refusal has to come from the parent directory, which is what the CLI would write into.
  const fs = fakeFs(baseTree());
  const { error } = checkReadable("/allowed/linkdir/x.md", ALLOWED, fs);
  assert.match(error, /must be inside an allowed folder/);
  assert.deepEqual(fs.calls, ["realpath /allowed/linkdir"], "R2 refused before the file itself was resolved");
});

// --- U3: the same fixture, with an output ------------------------------------------------------

test("U3: an output under the symlinked directory is refused too", () => {
  const fs = fakeFs(baseTree());
  const { error, output } = checkExportPaths(
    { input: "/allowed/plan.md", output: "/allowed/linkdir/x.pdf" },
    ALLOWED,
    fs,
  );
  assert.equal(output, undefined);
  assert.match(error, /`output` must be inside an allowed folder/);
});

// --- U4: reading, missing files, NUL and non-files ---------------------------------------------

test("U4: a missing file inside an allowed folder is passed through for the CLI to report", () => {
  const fs = fakeFs(baseTree());
  assert.deepEqual(checkReadable("/allowed/missing.md", ALLOWED, fs), { path: "/allowed/missing.md" });
});

test("U4: a missing path outside is refused with the very message an existing one gets", () => {
  const missing = checkReadable("/outside/missing.md", ALLOWED, fakeFs(baseTree()));
  const existing = checkReadable("/outside/real.md", ALLOWED, fakeFs(baseTree()));
  assert.match(missing.error, /must be inside an allowed folder/);
  assert.equal(missing.error, existing.error, "an outside path must not say whether it exists");
});

test("U4: a NUL byte is refused without one filesystem call", () => {
  const fs = fakeFs(baseTree());
  const { error } = checkReadable("/allowed/pl\u0000an.md", ALLOWED, fs);
  assert.match(error, /must be a plain absolute path/);
  assert.deepEqual(fs.calls, []);
});

test("U4: a directory and a FIFO inside an allowed folder are refused (R4)", () => {
  const fs = fakeFs(baseTree());
  assert.match(checkReadable("/allowed/sub", ALLOWED, fs).error, /`input` must be a file, not a folder/);
  assert.match(checkReadable("/allowed/pipe", ALLOWED, fs).error, /`input` must be a regular file/);
  assert.match(checkOpenPath("/allowed/sub", ALLOWED, fs).error, /MarsDawn 1\.1/);
});

// --- U5: writing -------------------------------------------------------------------------------

test("U5: a destination whose parent is missing is refused", () => {
  const fs = fakeFs(baseTree());
  assert.match(checkWritable("/allowed/missing/x.pdf", ALLOWED, fs).error, /must be inside an allowed folder/);
});

test("U5: a destination that is a symlink is refused, and says so", () => {
  const tree = baseTree();
  tree.lstat["/allowed/plan.pdf"] = "link";
  const { error } = checkWritable("/allowed/plan.pdf", ALLOWED, fakeFs(tree));
  assert.match(error, /symbolic link/);
  assert.match(error, /won't write through a symlink/);
});

test("U5: a destination that is a directory is refused", () => {
  const tree = baseTree();
  tree.lstat["/allowed/plan.pdf"] = "dir";
  assert.match(checkWritable("/allowed/plan.pdf", ALLOWED, fakeFs(tree)).error, /must be a regular file/);
});

test("U5: a destination whose parent is a symlink out is refused", () => {
  const fs = fakeFs(baseTree());
  assert.match(checkWritable("/allowed/linkdir/x.pdf", ALLOWED, fs).error, /must be inside an allowed folder/);
});

test("U5: a NUL byte in the destination is refused without one filesystem call", () => {
  const fs = fakeFs(baseTree());
  const { error } = checkWritable("/allowed/pl\u0000an.pdf", ALLOWED, fs);
  assert.match(error, /must be a plain absolute path/);
  assert.deepEqual(fs.calls, []);
});

test("U5: only a .pdf name may be written (W4)", () => {
  for (const bad of ["/allowed/x.txt", "/allowed/x.PDF.bak", "/allowed/x", "/allowed/x.pdf.txt"]) {
    assert.match(checkWritable(bad, ALLOWED, fakeFs(baseTree())).error, /`output` must name a \.pdf file\./, bad);
  }
  assert.deepEqual(checkWritable("/allowed/x.PDF", ALLOWED, fakeFs(baseTree())), { path: "/allowed/x.PDF" });
  assert.deepEqual(checkWritable("/allowed/x.pdf", ALLOWED, fakeFs(baseTree())), { path: "/allowed/x.pdf" });
});

// --- U6: the composed export check, with the default output ------------------------------------

test("U6: the filled-in default output is checked like any other, symlink and folder included", () => {
  const symlinked = baseTree();
  symlinked.lstat["/allowed/plan.pdf"] = "link";
  const bySymlink = checkExportPaths({ input: "/allowed/plan.md" }, ALLOWED, fakeFs(symlinked));
  assert.equal(bySymlink.output, undefined);
  assert.match(bySymlink.error, /symbolic link/);

  const folder = baseTree();
  folder.lstat["/allowed/plan.pdf"] = "dir";
  const byFolder = checkExportPaths({ input: "/allowed/plan.md" }, ALLOWED, fakeFs(folder));
  assert.equal(byFolder.output, undefined);
  assert.match(byFolder.error, /must be a regular file/);

  const existing = baseTree();
  existing.lstat["/allowed/plan.pdf"] = "file";
  assert.deepEqual(checkExportPaths({ input: "/allowed/plan.md" }, ALLOWED, fakeFs(existing)), {
    output: "/allowed/plan.pdf",
  });
  assert.deepEqual(checkExportPaths({ input: "/allowed/plan.md" }, ALLOWED, fakeFs(baseTree())), {
    output: "/allowed/plan.pdf",
  });
});

test("U6: the default output for each odd stem, through the composed check", () => {
  for (const [name, expected] of [
    ["plan.md", "plan.pdf"],
    ["notes", "notes.pdf"],
    [".hidden", ".hidden.pdf"],
    ["a.b.md", "a.b.pdf"],
    ["notes.", "notes.pdf"],
  ]) {
    const tree = baseTree();
    tree.realpath[`/allowed/${name}`] = `/allowed/${name}`;
    tree.lstat[`/allowed/${name}`] = "file";
    assert.equal(defaultOutputFor(`/allowed/${name}`), `/allowed/${expected}`, name);
    assert.deepEqual(checkExportPaths({ input: `/allowed/${name}` }, ALLOWED, fakeFs(tree)), {
      output: `/allowed/${expected}`,
    }, name);
  }
});

// --- U7: the configured folders ----------------------------------------------------------------

test("U7: a configured folder that is a symlink is realpath'd, so both spellings resolve inside", () => {
  const tree = {
    realpath: {
      "/link/docs": "/real/docs",
      "/real/docs": "/real/docs",
      "/real/docs/x.md": "/real/docs/x.md",
      "/link/docs/x.md": "/real/docs/x.md",
    },
    lstat: { "/real/docs": "dir", "/real/docs/x.md": "file" },
  };
  const { directories } = allowedDirectoriesFrom(["/link/docs"], fakeFs(tree));
  assert.deepEqual(directories, ["/real/docs"]);
  assert.deepEqual(checkReadable("/real/docs/x.md", directories, fakeFs(tree)), { path: "/real/docs/x.md" });
  assert.deepEqual(checkReadable("/link/docs/x.md", directories, fakeFs(tree)), { path: "/link/docs/x.md" });
});

test("U7: / is dropped, and never becomes an allowed folder", () => {
  const fs = fakeFs({ realpath: { "/": "/", "/link-to-root": "/" }, lstat: { "/": "dir" } });
  const { directories, notes } = allowedDirectoriesFrom(["/", "/link-to-root"], fs);
  assert.deepEqual(directories, []);
  assert.equal(notes.length, 2);
  for (const note of notes) assert.match(note, /dropped the allowed folder/);
});

test("U7: empty, whitespace and unfilled placeholders are ignored without touching the filesystem", () => {
  const fs = fakeFs(baseTree());
  const { directories, notes } = allowedDirectoriesFrom(["", "   ", "${user_config.allowed_directories}"], fs);
  assert.deepEqual(directories, []);
  assert.deepEqual(notes, []);
  assert.deepEqual(fs.calls, []);
});

test("U7: a relative folder is refused, a file or a missing folder is dropped, and the rest still work", () => {
  const tree = baseTree();
  tree.realpath["/allowed/plan.md"] = "/allowed/plan.md";
  const fs = fakeFs(tree);
  const { directories, notes } = allowedDirectoriesFrom(
    ["Documents", "/allowed/plan.md", "/nowhere", "/allowed"],
    fs,
  );
  assert.deepEqual(directories, ["/allowed"]);
  assert.match(notes[0], /refused the allowed folder Documents: it must be an absolute path/);
  assert.match(notes[1], /dropped the allowed folder \/allowed\/plan\.md/);
  assert.match(notes[2], /dropped the allowed folder \/nowhere/);
  assert.equal(notes.length, 3);
});

test("U7: duplicates collapse, however they are spelled", () => {
  const tree = { realpath: { "/allowed": "/allowed", "/link": "/allowed" }, lstat: { "/allowed": "dir" } };
  const { directories } = allowedDirectoriesFrom(["/allowed", "/link", "/allowed"], fakeFs(tree));
  assert.deepEqual(directories, ["/allowed"]);
});

// --- U8: the client's roots --------------------------------------------------------------------

test("U8: a file: root becomes a directory, and a root on another host is ignored", () => {
  const fs = fakeFs({ realpath: { "/allowed": "/allowed" }, lstat: { "/allowed": "dir" } });
  assert.deepEqual(rootsToDirectories([{ uri: "file:///allowed" }], fs), ["/allowed"]);
  assert.deepEqual(rootsToDirectories([{ uri: "file://evil/etc" }], fs), []);
});

test("U8: file:// and file:/// both mean /, which is dropped", () => {
  const fs = fakeFs({ realpath: { "/": "/" }, lstat: { "/": "dir" } });
  assert.deepEqual(rootsToDirectories([{ uri: "file://" }, { uri: "file:///" }], fs), []);
});

test("U8: an encoded NUL in a root is dropped", () => {
  const fs = fakeFs({ realpath: { "/allowed": "/allowed" } });
  assert.deepEqual(rootsToDirectories([{ uri: "file:///a%00b" }], fs), []);
});

test("U8: a root that names a file refuses everything, since no parent is inside a file", () => {
  const tree = {
    realpath: { "/allowed/notes.md": "/allowed/notes.md", "/allowed": "/allowed" },
    lstat: { "/allowed/notes.md": "file", "/allowed": "dir" },
  };
  const directories = rootsToDirectories([{ uri: "file:///allowed/notes.md" }], fakeFs(tree));
  assert.deepEqual(directories, ["/allowed/notes.md"]);
  assert.match(checkReadable("/allowed/notes.md", directories, fakeFs(tree)).error, /must be inside an allowed folder/);
});

test("U8: the SDK refuses a whole roots result that holds a non-file root", () => {
  // This is why an https: root means "no roots" for that call rather than one ignored entry.
  assert.equal(ListRootsResultSchema.safeParse({ roots: [{ uri: "file:///allowed" }] }).success, true);
  assert.equal(
    ListRootsResultSchema.safeParse({ roots: [{ uri: "file:///allowed" }, { uri: "https://example.com/" }] }).success,
    false,
  );
});

test("U8: with no folder from either source, every call is refused and the message names both routes", () => {
  for (const check of [
    () => checkReadable("/allowed/plan.md", [], fakeFs(baseTree())),
    () => checkWritable("/allowed/plan.pdf", [], fakeFs(baseTree())),
    () => checkOpenPath("/allowed/plan.md", [], fakeFs(baseTree())),
    () => checkExportPaths({ input: "/allowed/plan.md" }, [], fakeFs(baseTree())),
  ]) {
    assert.equal(check().error, NOTHING_ALLOWED);
  }
  assert.match(NOTHING_ALLOWED, /"Allowed folders"/);
  assert.match(NOTHING_ALLOWED, /arguments/);
  assert.match(NOTHING_ALLOWED, /roots/);
});
