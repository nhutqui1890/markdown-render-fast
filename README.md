[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/nhutqui1890/markdown-render-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/nhutqui1890/markdown-render-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-fast

A dependency-free JavaScript Markdown parser built for speed, producing HTML
byte-identical to marked 18.1.3 (default options, GFM on) on CommonMark
0.31.2 spec examples, GFM extensions, and long generated documents.

- `parse.js` — the parser: `export function parse(markdown)`. A line-based
  block parser plus a single-pass inline parser (delimiter stack for
  emphasis, bracket stack for links), hand-rolled scanning, no regexes on
  hot paths, rendering straight to strings.
- `main.ts` — the driver: reads `cases.json` from `MAKEFUN_INPUT_DIR`,
  renders each case with `parse()`, writes `html.json` to
  `MAKEFUN_OUTPUT_DIR`.

Built for the [make.fun bounty](https://make.fun/bounty/markdown-render-speed-02)
"Make Markdown rendering faster" (markdown-render-speed-02).

## License

MIT — see LICENSE.
