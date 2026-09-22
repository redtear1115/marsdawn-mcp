# marsdawn-mcp

An MCP server that lets an AI agent export Markdown to PDF and open Markdown files in the
MarsDawn app, on macOS, by running the
[`marsdawn`](https://marsdawn.southern-light.dev/cli/) command-line tool you already have. It's a
channel for clients that have no shell of their own; where a shell is available, driving
`marsdawn` directly is simpler.

The first release, [0.1.0](https://github.com/redtear1115/marsdawn-mcp/releases/tag/v0.1.0), is
an MCP Bundle, `marsdawn.mcpb`, attached to the release. It isn't listed in the MCP Registry
yet; `server.json` is the entry that will be published there as `dev.southern-light.mcp/marsdawn`.

## What it does

Two tools.

### `export_markdown_to_pdf`

Runs `marsdawn export <input> --json` and returns the CLI's JSON result as structured content,
so the PDF looks the way it does from the command line: rendered like MarsDawn's preview,
Mermaid diagrams included.

| Argument | |
|---|---|
| `input` | Absolute path of the Markdown file. Required. |
| `output` | Absolute path for the PDF. Defaults to the input path with a `.pdf` extension. |
| `theme` | `dawn`, `classic`, `modern` or `vivid`. |
| `paper` | `a4` or `letter`. |
| `force` | Replace an existing PDF. Without it, an existing PDF is left alone and the tool says so. |
| `allowRemoteImages` | Load web images while rendering. Off by default. |

### `open_in_marsdawn`

Runs `marsdawn open <path>[:line] --json` and returns the CLI's JSON result. Needs the MarsDawn
app installed, which isn't publicly available yet; call it once per file, since the window it
opens follows that file's later edits by itself, without being called again.

| Argument | |
|---|---|
| `path` | Absolute path of an existing Markdown file, not a folder. Required. |
| `line` | Line to land on, 1 to 999999999. |
| `background` | Open without bringing MarsDawn to the front. |

No `folder` yet: the launch build's `marsdawn open --folder` answers with an error dialog in the
app, so this tool doesn't offer it. It returns once folders ship in app 1.1 and the site
publishes `open.v3.json` for them.

A failure from either tool comes back as an error with the CLI's message and what to do next. A
missing MarsDawn app (`open_in_marsdawn` only) comes back the same way, not as a thrown error.

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
