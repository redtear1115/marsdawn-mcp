// The tools as MCP clients see them. Enums and output fields come from the vendored schemas.

import { MAX_LINE, MINIMUM_VERSION, PAPERS, THEMES, exportSchema, openSchema } from "./marsdawn.js";

/**
 * A vendored schema without `$schema`, `$id` and `title`. Clients validate `structuredContent`
 * with their own JSON Schema library; the TypeScript SDK's accepts a 2020-12 `$schema`, but not
 * every client's is known to. The schema uses no keyword newer than draft-07, so dropping the
 * declaration loses nothing.
 */
function withoutMeta(schema) {
  const { $schema, $id, title, ...rest } = schema;
  return rest;
}

/** export.v1.json without `$schema`, `$id` and `title`. */
export function outputSchema() {
  return withoutMeta(exportSchema);
}

export const exportTool = {
  name: "export_markdown_to_pdf",
  title: "Export Markdown to PDF",
  description: [
    "Export a Markdown file to a paginated PDF on this Mac with the marsdawn command-line tool,",
    "rendered like MarsDawn's preview, Mermaid diagrams included.",
    `Needs marsdawn ${MINIMUM_VERSION} or later (\`brew install redtear1115/tap/marsdawn\`).`,
    "Writes the PDF beside the input unless `output` is given, and won't replace an existing PDF",
    "unless `force` is true. Web images are left out unless `allowRemoteImages` is true.",
  ].join(" "),
  inputSchema: {
    type: "object",
    required: ["input"],
    additionalProperties: false,
    properties: {
      input: {
        type: "string",
        description: "Absolute path of the Markdown file to export.",
      },
      output: {
        type: "string",
        description: "Absolute path to write the PDF to. Defaults to the input path with a .pdf extension.",
      },
      theme: {
        type: "string",
        enum: THEMES,
        description: "Preview theme (light palette). Defaults to $MARSDAWN_THEME, or dawn.",
      },
      paper: {
        type: "string",
        enum: PAPERS,
        description: "Paper size. Defaults to a4.",
      },
      force: {
        type: "boolean",
        description: "Replace the output file if it already exists.",
      },
      allowRemoteImages: {
        type: "boolean",
        description: "Load images from the web while rendering. This reaches the network.",
      },
    },
  },
  outputSchema: outputSchema(),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const openTool = {
  name: "open_in_marsdawn",
  title: "Open in MarsDawn",
  description: [
    "Open a Markdown file in the MarsDawn app on this Mac for the user to review, with the marsdawn",
    "command-line tool. Needs the MarsDawn app, which is not publicly available yet.",
    "Call this once per file: the window stays open and follows the file's later edits by itself,",
    "so there's no need to call it again after every change, only when a new file needs review or",
    "the user should be sent to a different line.",
    "`background` opens the file without bringing MarsDawn to the front, so the window the user is",
    "already working in keeps focus.",
  ].join(" "),
  inputSchema: {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Absolute path of the Markdown file to open. Must be a file, not a folder.",
      },
      line: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LINE,
        description: "Line to land on.",
      },
      background: {
        type: "boolean",
        description: "Open without bringing MarsDawn to the front.",
      },
    },
  },
  outputSchema: withoutMeta(openSchema),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
