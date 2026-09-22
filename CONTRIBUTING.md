# Contributing

marsdawn-mcp is the MCP server that lets an AI agent export Markdown to PDF and open Markdown
files in the MarsDawn app, on macOS, by running the `marsdawn` CLI. This repo covers the server,
its two tools (`export_markdown_to_pdf`, `open_in_marsdawn`), the bundle (`manifest.json`,
packaging) and `server.json`.

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## What goes elsewhere

- Bugs in the `marsdawn` CLI itself, the Markdown renderer or PDF output —
  [mars-dawn-kit](https://github.com/redtear1115/mars-dawn-kit). This server is a thin wrapper
  around that CLI; if the exported PDF is wrong, the bug is almost always there, not here.
- Questions or feedback about the MarsDawn Mac app itself —
  [mars-dawn-website/discussions](https://github.com/redtear1115/mars-dawn-website/discussions).

## Requirements

- macOS, with `marsdawn` 0.5.0 or later: `brew install redtear1115/tap/marsdawn`.
- Node.js 20 or later.

## Build and test locally

```sh
git clone https://github.com/redtear1115/marsdawn-mcp.git
cd marsdawn-mcp
npm ci
npm test               # unit and stdio tests, against a fake marsdawn
npm run check-schemas  # the vendored schemas match the ones the site publishes
npx mcpb validate manifest.json
node scripts/check-server-json.js   # server.json's fileSha256 matches the release asset
```

CI also builds the bundle and drives it against a real `marsdawn` installed from the tap; you don't
need to reproduce that locally unless you're touching packaging.

`schemas/` holds copies of the JSON Schemas published at
`https://marsdawn.southern-light.dev/schemas/cli/`. Update them by copying the published files,
never by editing them here.

## Releasing

`release.yml` is `workflow_dispatch` only (write access to the repo is required to dispatch it, so
fork PRs can never reach it), with `concurrency: release` so only one run goes at a time. It has
three jobs: `build` (packs and smoke-tests, read-only), `publish` (drafts, verifies and publishes
the GitHub release, then stamps), and `stamp` (the `stamp_only` recovery job, below). `publish` and
`stamp` are the two jobs with write access; `build` is read-only. Both `publish`'s stamp step and
job `stamp` run no `npm`, `npx`, `brew` or `pack.sh` — everything they act on was already built and
verified by job `build`.

1. Merge a version-bump PR (package.json, package-lock.json, manifest.json and server.json all
   move to the new version; server.json's `fileSha256` is left as the previous release's — it's
   corrected in step 3). CI's `server-json` job runs `--allow-unreleased` on push to `main` too,
   so it's green right after the merge (the new version has no release yet, which is exactly what
   `--allow-unreleased` is for).
2. From `main`, run **Actions ▸ Release ▸ Run workflow**, with `dry_run` and `stamp_only` left
   unchecked (an optional `notes` input is appended to the release's notes). It builds,
   smoke-tests, drafts, verifies the asset's hash and publishes the GitHub release, then pushes a
   branch, `release/v<version>-server-json`, that stamps server.json's `fileSha256` with the
   published asset's real hash. The run's job summary links the branch's compare page — Actions
   can't open a PR here (no `can_approve_pull_request_reviews`), so open one from that link by
   hand. Between the release publishing and that PR merging, `server-json` on `main` goes red: the
   release now exists, so `--allow-unreleased` runs the strict check, and `main`'s `fileSha256` is
   still the placeholder until step 3. Expected and temporary.
3. Merge the stamp PR. Before merging it, run the **strict** check by hand (no
   `--allow-unreleased`) against its tree:

   ```sh
   node scripts/check-server-json.js
   ```

4. Publish to the MCP Registry by hand — this needs the owner's DNS private key, which never
   leaves the Futari Secrets disk image and never becomes a GitHub secret. Run the strict check
   first, same as step 3, then follow the `mcp-publisher` steps in the publish guide.

`dry_run` runs job `build` only: a rehearsal of the packing and smoke test, with no draft, no
release and no push — useful to check the ref guard and the version-consistency check (step 1)
without touching anything.

### Recovery

- **A stale draft release**: delete it — `gh api -X DELETE repos/redtear1115/marsdawn-mcp/releases/<id>`
  (a draft creates no tag, so nothing else needs cleaning up) — then rerun the release workflow.
  The workflow checks for this itself before drafting: it lists every release and fails, naming the
  id, if one already has the tag it's about to use.
- **A release published but no stamp branch/PR**: rerun the release workflow with `stamp_only`
  checked. That runs job `stamp` alone, which refuses unless a **published** (non-draft) release
  for the current version already exists, then redoes only the stamp step against it.

These are the two recovery paths the release workflow's design accounts for. Neither has been
exercised against a forced failure yet: the owner declined standing up a throwaway repo to
rehearse them, so the first real release run (v0.2.0) is also the first real execution of the
draft → verify → publish steps, and the first time either recovery path gets used for real, not
just reasoned about.

## Issues and pull requests

Keep pull requests small and focused. Describe what changed and why. CI runs the unit tests across
Node 20/22/24, the schema check, manifest validation, the packed-bundle smoke test and the
`server.json` hash check — all of it needs to be green before review.

## License

By contributing, you agree that your contribution is licensed under this repository's Apache-2.0
license (see [LICENSE](LICENSE)), on the same inbound = outbound basis as the rest of the project.
