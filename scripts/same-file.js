// "The CLI wrote the file the server named": the check smoke-bundle.js makes for every default
// output, kept here so test/same-file.test.js can prove it fails when the claim is false.
//
// The reported path and the expected one may be spelled differently for the same file: Foundation's
// standardizedFileURL drops a leading /private once the path exists, so the CLI can report
// /var/folders/…/x.pdf for a --output of /private/var/folders/…/x.pdf. Spelling is not the claim.
// Identity is: the two must resolve to the same string and the same inode, and the file must be
// newer than it was before the call, so a stale file from an earlier case can't stand in.

import assert from "node:assert/strict";
import { existsSync, realpathSync, statSync } from "node:fs";

/** What `expected` looked like before the call: its mtime, or `undefined` if it wasn't there. */
export function snapshot(expected) {
  return existsSync(expected) ? statSync(expected).mtimeMs : undefined;
}

/**
 * Throws unless `reported` and `expected` are one file, on disk, non-empty, and written after
 * `before` (a `snapshot(expected)` taken before the call).
 */
export function assertSameWrittenFile({ reported, expected, before, label = "the output" }) {
  assert.equal(typeof reported, "string", `${label}: the CLI reported a path`);
  assert.equal(realpathSync.native(reported), expected, `${label}: reported ${reported}, expected ${expected}`);
  const written = statSync(expected);
  assert.equal(statSync(reported).ino, written.ino, `${label}: ${reported} and ${expected} are the same inode`);
  assert.ok(written.size > 0, `${label}: ${expected} is on disk and not empty`);
  if (before !== undefined) {
    assert.ok(written.mtimeMs > before, `${label}: ${expected} was rewritten by this call, not left from before`);
  }
}
