// Fails when a vendored schema differs by even a byte from the one the site publishes.
// The site's generator is the author; this repository only keeps a copy for offline use.

import { readFileSync } from "node:fs";

const base = "https://marsdawn.southern-light.dev/schemas/cli/";
const names = ["export.v1.json", "open.v2.json", "error.v1.json"];

let drifted = 0;
for (const name of names) {
  const response = await fetch(base + name);
  if (!response.ok) {
    console.error(`${name}: ${base + name} answered ${response.status}`);
    drifted += 1;
    continue;
  }
  const published = Buffer.from(await response.arrayBuffer());
  const vendored = readFileSync(new URL(`../schemas/${name}`, import.meta.url));
  if (published.equals(vendored)) {
    console.log(`${name}: matches the published copy`);
  } else {
    console.error(`${name}: differs from ${base + name}; copy the published file into schemas/`);
    drifted += 1;
  }
}
process.exit(drifted === 0 ? 0 : 1);
