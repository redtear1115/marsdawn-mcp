#!/usr/bin/env node
// An MCP server over stdio with two tools, export_markdown_to_pdf and open_in_marsdawn.

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { configuredPathFrom, createExporter, createOpener } from "./marsdawn.js";
import { exportTool, openTool } from "./tool.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const configuredPath = configuredPathFrom(process.env.MARSDAWN_PATH);
const runners = {
  [exportTool.name]: { tool: exportTool, run: createExporter({ configuredPath }) },
  [openTool.name]: { tool: openTool, run: createOpener({ configuredPath }) },
};

const server = new Server({ name: "marsdawn", version }, { capabilities: { tools: {} } });

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
