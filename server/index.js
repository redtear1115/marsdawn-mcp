#!/usr/bin/env node
// An MCP server over stdio with one tool, export_markdown_to_pdf.

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { configuredPathFrom, createExporter } from "./marsdawn.js";
import { exportTool } from "./tool.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const exportMarkdown = createExporter({ configuredPath: configuredPathFrom(process.env.MARSDAWN_PATH) });

const server = new Server({ name: "marsdawn", version }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [exportTool] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== exportTool.name) {
    return { isError: true, content: [{ type: "text", text: `No tool named ${request.params.name}.` }] };
  }
  return exportMarkdown(request.params.arguments);
});

await server.connect(new StdioServerTransport());
