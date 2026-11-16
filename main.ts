// main.ts — driver for the markdown-render-speed-02 entry.
// Reads cases.json from MAKEFUN_INPUT_DIR (default /input), renders each
// case alone with parse(), writes html.json (JSON array of HTML strings,
// in order) to MAKEFUN_OUTPUT_DIR (default /output).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

const cases = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8"));
const html: string[] = [];
for (const c of cases) {
  html.push(parse(typeof c === "string" ? c : c.markdown));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
