// The smoke test's "the CLI wrote the file the server named" check, shown to pass for the one case
// it must tolerate (two spellings of one file) and to fail for the two ways the claim can be false.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertSameWrittenFile, snapshot } from "../scripts/same-file.js";

/** A temp folder in both spellings: as tmpdir() gives it (/var/… on macOS) and realpath'd. */
function folders() {
  const spelled = mkdtempSync(join(tmpdir(), "marsdawn-same-file-"));
  return { spelled, real: realpathSync.native(spelled) };
}

test("same file: a differently spelled path to the file the server named passes", () => {
  const { spelled, real } = folders();
  const expected = join(real, "notes.pdf");
  const before = snapshot(expected);
  assert.equal(before, undefined);
  writeFileSync(expected, "%PDF-");
  assertSameWrittenFile({ reported: join(spelled, "notes.pdf"), expected, before });
  assertSameWrittenFile({ reported: expected, expected, before });
});

test("same file: a report naming a different file fails, even one beside it", () => {
  const { real } = folders();
  const expected = join(real, "notes.pdf");
  const other = join(real, "notes..pdf");
  writeFileSync(expected, "%PDF-");
  writeFileSync(other, "%PDF-");
  assert.throws(
    () => assertSameWrittenFile({ reported: other, expected, before: undefined }),
    /reported .*notes\.\.pdf, expected .*notes\.pdf/,
  );
});

test("same file: a file left over from before the call fails", () => {
  const { real } = folders();
  const expected = join(real, "notes.pdf");
  writeFileSync(expected, "%PDF-");
  const stale = new Date(Date.now() - 60_000);
  utimesSync(expected, stale, stale);
  const before = snapshot(expected);
  assert.throws(
    () => assertSameWrittenFile({ reported: expected, expected, before }),
    /was rewritten by this call, not left from before/,
  );
  // And once the call really rewrites it, the same snapshot passes.
  writeFileSync(expected, "%PDF-1.7");
  assertSameWrittenFile({ reported: expected, expected, before });
});

test("same file: an empty file fails", () => {
  const { real } = folders();
  const expected = join(real, "notes.pdf");
  writeFileSync(expected, "");
  assert.throws(() => assertSameWrittenFile({ reported: expected, expected, before: undefined }), /not empty/);
});
