# Contributing

marsdawn-mcp is the MCP server that lets an AI agent export Markdown to PDF on macOS by running
the `marsdawn` CLI. This repo covers the server, its one tool (`export_markdown_to_pdf`), the
bundle (`manifest.json`, packaging) and `server.json`.

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

## Issues and pull requests

Keep pull requests small and focused. Describe what changed and why. CI runs the unit tests across
Node 20/22/24, the schema check, manifest validation, the packed-bundle smoke test and the
`server.json` hash check — all of it needs to be green before review.

## License

By contributing, you agree that your contribution is licensed under this repository's Apache-2.0
license (see [LICENSE](LICENSE)), on the same inbound = outbound basis as the rest of the project.
