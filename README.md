# marsdawn-mcp

An MCP server that lets an AI agent export Markdown to PDF on macOS by running the
[`marsdawn`](https://marsdawn.southern-light.dev/cli/) command-line tool you already have.

The first release, [0.1.0](https://github.com/redtear1115/marsdawn-mcp/releases/tag/v0.1.0), is
an MCP Bundle, `marsdawn.mcpb`, attached to the release. It isn't listed in the MCP Registry
yet; `server.json` is the entry that will be published there as `dev.southern-light.mcp/marsdawn`.

## What it does

One tool, `export_markdown_to_pdf`. It runs `marsdawn export <input> --json` and returns the
CLI's JSON result as structured content, so the PDF looks the way it does from the command line:
rendered like MarsDawn's preview, Mermaid diagrams included.

| Argument | |
|---|---|
| `input` | Absolute path of the Markdown file. Required. |
| `output` | Absolute path for the PDF. Defaults to the input path with a `.pdf` extension. |
| `theme` | `dawn`, `classic`, `modern` or `vivid`. |
| `paper` | `a4` or `letter`. |
| `force` | Replace an existing PDF. Without it, an existing PDF is left alone and the tool says so. |
| `allowRemoteImages` | Load web images while rendering. Off by default. |

A failure comes back as an error with the CLI's message and what to do next.

## Requirements

- macOS, with `marsdawn` 0.5.0 or later: `brew install redtear1115/tap/marsdawn`.
- Node.js 20 or later.

The server looks for `marsdawn` at the path in `MARSDAWN_PATH` if that's set, then in `PATH`,
then in `/opt/homebrew/bin` and `/usr/local/bin`.

## Run it from source

```sh
git clone https://github.com/redtear1115/marsdawn-mcp.git
cd marsdawn-mcp
npm ci --omit=dev
```

Then point your MCP client at `node /absolute/path/to/marsdawn-mcp/server/index.js` over stdio.

## Development

```sh
npm ci
npm test               # unit and stdio tests, against a fake marsdawn
npm run check-schemas  # the vendored schemas match the ones the site publishes
npx mcpb validate manifest.json
node scripts/check-server-json.js   # server.json's fileSha256 matches the release asset
```

`schemas/` holds copies of the JSON Schemas published at
`https://marsdawn.southern-light.dev/schemas/cli/`. The site is where they're written; update
them by copying the published files, never by editing them here.

## License

Apache License 2.0. See [LICENSE](LICENSE).
