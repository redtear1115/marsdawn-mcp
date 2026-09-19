// The tool as MCP clients see it. Enums and output fields come from the vendored schemas.

import { MINIMUM_VERSION, PAPERS, THEMES, exportSchema } from "./marsdawn.js";

/**
 * export.v1.json without `$schema`, `$id` and `title`. Clients validate `structuredContent`
 * with their own JSON Schema library; the TypeScript SDK's accepts a 2020-12 `$schema`, but not
 * every client's is known to. The schema uses no keyword newer than draft-07, so dropping the
 * declaration loses nothing.
 */
export function outputSchema() {
  const { $schema, $id, title, ...schema } = exportSchema;
  return schema;
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
