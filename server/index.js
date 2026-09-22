#!/usr/bin/env node
// An MCP server over stdio with two tools, export_markdown_to_pdf and open_in_marsdawn.
// Every positional argument is a folder the tools may read from and write into; the client's MCP
// roots, when it offers them, are allowed too. With neither, every call is refused.

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { allowedDirectoriesFrom, rootsToDirectories } from "./allowed.js";
import { configuredPathFrom, createExporter, createOpener } from "./marsdawn.js";
import { exportTool, openTool } from "./tool.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** How long the client has to answer `roots/list`; the SDK's own default would be 60 seconds. */
export const ROOTS_TIMEOUT_MS = 5000;

/** How long a failed `roots/list` is remembered, so a stalled client costs one wait, not one a call. */
export const ROOTS_FAILURE_MS = 30_000;

const positional = process.argv.slice(2);
process.stderr.write(`marsdawn-mcp ${version} argv: ${JSON.stringify(positional)}\n`);
const { directories: configured, notes } = allowedDirectoriesFrom(positional);
for (const note of notes) process.stderr.write(`marsdawn-mcp: ${note}\n`);

const server = new Server({ name: "marsdawn", version }, { capabilities: { tools: {} } });

/**
 * The client's roots, asked for on the first tool call that needs them and never inside
 * `initialize`. Cached only when the client said it will announce changes; an error, a timeout or
 * a result the SDK won't parse means "no roots" for that call, never "everything".
 */
function createRootsProvider(connection) {
  let cached;
  let failedAt;
  return {
    forget() {
      cached = undefined;
      failedAt = undefined;
    },
    async read() {
      const roots = connection.getClientCapabilities()?.roots;
      if (!roots) return [];
      if (cached) return cached;
      if (failedAt !== undefined && Date.now() - failedAt < ROOTS_FAILURE_MS) return [];
      let result;
      try {
        result = await connection.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
      } catch {
        failedAt = Date.now();
        return [];
      }
      const directories = rootsToDirectories(result?.roots);
      if (roots.listChanged === true) cached = directories;
      return directories;
    },
  };
}

const rootsProvider = createRootsProvider(server);

server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  rootsProvider.forget();
});

/** The configured folders and the client's roots, as one deduplicated list. */
async function allowed() {
  const directories = [...configured];
  for (const directory of await rootsProvider.read()) {
    if (!directories.includes(directory)) directories.push(directory);
  }
  return directories;
}

const configuredPath = configuredPathFrom(process.env.MARSDAWN_PATH);
const runners = {
  [exportTool.name]: { tool: exportTool, run: createExporter({ configuredPath, allowed }) },
  [openTool.name]: { tool: openTool, run: createOpener({ configuredPath, allowed }) },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.values(runners).map((runner) => runner.tool),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const runner = runners[request.params.name];
  if (!runner) {
    return { isError: true, content: [{ type: "text", text: `No tool named ${request.params.name}.` }] };
  }
  return runner.run(request.params.arguments);
});

await server.connect(new StdioServerTransport());
