// parse.js — dependency-free Markdown parser producing HTML byte-identical to
// marked 18.1.3 (default options, GFM on). Written from scratch for the
// make.fun markdown-render-speed-02 competition. Original implementation;
// behavior verified against the marked reference, not copied from it.

/* ---------------- character classes ---------------- */

// ASCII punctuation (for backslash escapes and flanking).
const ASCII_PUNCT = new Set(
  "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split(""),
);

// Fast ASCII class table: 0 = other, 1 = space, 2 = punctuation.
const CLS = new Uint8Array(128);
for (let i = 0; i < 128; i++) {
  const c = String.fromCharCode(i);
  if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") CLS[i] = 1;
  else if (ASCII_PUNCT.has(c)) CLS[i] = 2;
}
const RE_UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const RE_UNICODE_SPACE = /\s/;
const RE_ALNUM = /[\p{L}\p{N}]/u;

function charClass(ch) {
  // ch: single code unit string (or "" for start/end of input).
  if (ch === "") return 1; // start/end of line counts as whitespace
  const code = ch.charCodeAt(0);
  if (code < 128) return CLS[code];
  if (RE_UNICODE_SPACE.test(ch)) return 1;
  if (RE_UNICODE_PUNCT.test(ch)) return 2;
  return 0;
}

/* ---------------- escaping / entities ---------------- */

const ESC_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// escape-all: & < > " ' (used for code spans, autolink href/text).
function escAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

// escape, but leave valid-looking entities (&word; &#123; &#x1F;) untouched.
// Used for normal text (after numeric refs are decoded), hrefs, titles, alt.
const RE_ESC_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function escNoEnc(s) {
  if (!/[<>"']/.test(s) && s.indexOf("&") === -1) return s;
  return s.replace(RE_ESC_NOENC, (c) => ESC_MAP[c]);
}

// Decode numeric character references in text; bare & becomes &amp;.
// Named entities are NOT decoded (marked leaves them verbatim).
const RE_NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeText(s) {
  if (s.indexOf("&") === -1) return s;
  if (!/&(?:#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6});/.test(s) && !/&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(s)) return s;
  return s.replace(RE_NUMREF, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const n = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\uFFFD";
    if (n === 38) return "&amp;";
    return String.fromCodePoint(n);
  });
}

// Render a text node: decode numeric refs, then escape (entities preserved).
function renderText(s) {
  return escNoEnc(decodeText(s));
}

/* ---------------- URLs ---------------- */

function cleanUrl(url) {
  try {
    return encodeURI(url).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

// Process backslash escapes (only before ASCII punctuation) in a raw string.
function unescapeStr(s) {
  if (s.indexOf("\\") === -1) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// Normalize a link label: collapse internal whitespace to single spaces,
// trim, case-fold (Unicode lowercase + full folding for ß/ligatures).
function normalizeLabel(s) {
  return s.replace(/\s+/g, " ").trim().toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ﬀ/g, "ff").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl")
    .replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl").replace(/ﬅ/g, "st").replace(/ﬆ/g, "st")
    .replace(/µ/g, "μ");
}

// Collapse whitespace runs (incl. newlines) to a single space, for
// multi-line link destinations and titles.
function collapseWs(s) {
  return s.replace(/\s+/g, " ");
}

/* ---------------- link reference definitions ---------------- */

// Parse a link reference definition starting at line `li` (already stripped
// of up to 3 leading spaces and container prefixes). Returns
// { label, dest, title, nextLine } or null. `lines` is the full line array.
function parseRefDef(lines, li, text) {
  // text: the line content (no leading spaces), starting with '['.
  // Label: [ ... ] — may contain balanced brackets and backslash escapes,
  // and may span lines.
  let src = text;
  let endLine = li;
  let labelEnd = -1;
  {
    let depth = 0;
    let i = 1;
    for (;;) {
      while (i < src.length) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "[") { depth++; i++; continue; }
        if (c === "]") {
          if (depth === 0) { labelEnd = i; break; }
          depth--; i++; continue;
        }
        i++;
      }
      if (labelEnd !== -1) break;
      if (endLine + 1 >= lines.length) return null;
      endLine++;
      if (lines[endLine].trim() === "") return null;
      src += "\n" + lines[endLine];
    }
  }
  const rawLabel = src.slice(1, labelEnd);
  if (rawLabel.trim() === "") return null;
  if (rawLabel.length > 999) return null;
  // a def label cannot contain unescaped '[' or ']' (marked's def regex)
  {
    let hasBracket = false;
    for (let k = 0; k < rawLabel.length; k++) {
      if (rawLabel[k] === "\\") { k++; continue; }
      if (rawLabel[k] === "[" || rawLabel[k] === "]") { hasBracket = true; break; }
    }
    if (hasBracket) return null;
  }
  const label = normalizeLabel(rawLabel);
  if (label === "") return null;
  // Join further lines (up to a blank line) so the dest/title may span lines.
  while (endLine + 1 < lines.length && lines[endLine + 1].trim() !== "") {
    endLine++;
    src += "\n" + lines[endLine];
  }
  const rest = src.slice(labelEnd + 1);
  let p = 0;
  while (p < rest.length && (rest[p] === " " || rest[p] === "\t" || rest[p] === "\n")) p++;
  if (rest[p] !== ":") return null;
  p++;
  while (p < rest.length && (rest[p] === " " || rest[p] === "\t" || rest[p] === "\n")) p++;
  if (p >= rest.length) return null;
  let dest = "";
  if (rest[p] === "<") {
    const close = rest.indexOf(">", p + 1);
    if (close === -1) return null;
    dest = rest.slice(p + 1, close);
    if (/[\n<>]/.test(dest)) return null;
    dest = unescapeStr(collapseWs(dest));
    p = close + 1;
  } else {
    // bare destination: no spaces, balanced parens
    let depth = 0;
    const start = p;
    while (p < rest.length) {
      const c = rest[p];
      if (c === " " || c === "\t" || c === "\n") break;
      if (c === "\\" && p + 1 < rest.length && ASCII_PUNCT.has(rest[p + 1])) { p += 2; continue; }
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
      p++;
    }
    if (depth !== 0) return null;
    dest = rest.slice(start, p);
    if (dest === "") return null;
    dest = unescapeStr(dest);
  }
  // optional title: separated from the dest by spaces/tabs, or by one
  // newline (+ spaces). A title quote directly after the dest (no
  // whitespace) is junk, not a title.
  let title = null;
  let consumed = p;
  {
    // skip spaces/tabs on the dest's line
    let q = p;
    let hadWs = false;
    while (q < rest.length && (rest[q] === " " || rest[q] === "\t")) { q++; hadWs = true; }
    const destLineEnd = q; // end of the dest (no title) if no title follows
    // maybe the title is on the next line
    if (q < rest.length && rest[q] === "\n") {
      let q2 = q + 1;
      while (q2 < rest.length && (rest[q2] === " " || rest[q2] === "\t")) q2++;
      if (q2 < rest.length && (rest[q2] === '"' || rest[q2] === "'" || rest[q2] === "(")) {
        q = q2;
        hadWs = true;
      }
    }
    if (q < rest.length && (rest[q] === '"' || rest[q] === "'" || rest[q] === "(")) {
      if (!hadWs) return null; // junk directly after the dest
      const t0 = rest[q];
      // is the title on a later line than the dest? (then a failed title
      // falls back to the no-title def; same-line failure kills the def)
      let destNl = 0;
      for (let k = 0; k < p; k++) if (rest[k] === "\n") destNl++;
      let titleNl = 0;
      for (let k = 0; k < q; k++) if (rest[k] === "\n") titleNl++;
      const titleLaterLine = titleNl > destNl;
      let titleEnd = -1;
      let tval = null;
      if (t0 === '"' || t0 === "'") {
        // scan for the closing quote, respecting backslash escapes
        let r = q + 1;
        while (r < rest.length) {
          if (rest[r] === "\\") { r += 2; continue; }
          if (rest[r] === t0) { titleEnd = r + 1; tval = unescapeStr(rest.slice(q + 1, r)); break; }
          r++;
        }
      } else {
        let depth = 1;
        let r = q + 1;
        while (r < rest.length && depth > 0) {
          const c = rest[r];
          if (c === "\\") { r += 2; continue; }
          if (c === "(") depth++;
          else if (c === ")") depth--;
          r++;
        }
        if (depth === 0) { titleEnd = r; tval = unescapeStr(rest.slice(q + 1, r - 1)); }
      }
      if (titleEnd !== -1) {
        // after the title, only spaces/tabs to the end of the line
        let r = titleEnd;
        while (r < rest.length && (rest[r] === " " || rest[r] === "\t")) r++;
        if (r >= rest.length || rest[r] === "\n") {
          title = tval;
          consumed = r;
        } else if (titleLaterLine) {
          // junk after a next-line title: fall back to the no-title def
          consumed = destLineEnd;
        } else {
          return null; // junk after a same-line title kills the def
        }
      } else if (titleLaterLine) {
        // unterminated next-line title: fall back to the no-title def
        consumed = destLineEnd;
      } else {
        return null; // unterminated same-line title kills the def
      }
    } else if (q < rest.length && rest[q] !== "\n") {
      return null; // junk after the dest on its line
    } else {
      consumed = destLineEnd;
    }
  }
  // nextLine: count newlines from the def start to the consumed position
  // (the label itself may span lines)
  const consumedText = src.slice(0, labelEnd + 1 + consumed);
  let nl = 0;
  for (let k = 0; k < consumedText.length; k++) if (consumedText[k] === "\n") nl++;
  return { label, dest, title, nextLine: li + nl + 1 };
}

/* ---------------- inline parsing ---------------- */

// Node types
const T_TEXT = 0, T_CODE = 1, T_HTML = 2, T_BR = 3, T_SOFT = 4,
      T_DELIM = 5, T_BRACKET = 6, T_EM = 7, T_LINK = 8, T_IMAGE = 9,
      T_GFM = 10, T_AUTO = 11, T_ESC = 12;

// --- HTML tag / autolink matching (spec inline HTML + autolink rules) ---

const RE_TAG = /^(?:<!-->|<!--->|<!--(?:[^-]|-(?!->))*?-->|^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|^<\/[A-Za-z][A-Za-z0-9-]*\s*>|^<\?[\s\S]*?\?>|^<![A-Za-z]+[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>)/;
const RE_AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;

// Try to match an HTML tag or <...> autolink at src[pos].
// Returns { end, isAuto, href, text } or null.
function matchTagOrAuto(src, pos) {
  const sub = src.slice(pos);
  let m = RE_AUTOLINK.exec(sub);
  if (m) {
    const inner = m[1];
    const isEmail = inner.indexOf(":") === -1;
    return { end: pos + m[0].length, isAuto: true,
             href: isEmail ? "mailto:" + inner : inner, text: inner };
  }
  m = RE_TAG.exec(sub);
  if (m) return { end: pos + m[0].length, isAuto: false };
  return null;
}

// --- GFM autolinks (www / scheme / email / mailto: / xmpp:) ---

const RE_EMAIL_DOMAIN = /[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/y;
const RE_BACKPEDAL = /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RE_WWW_DOMAIN = /^(?:[A-Za-z0-9-]+\.?)+[^\s<]*/;

// --- link label validation (marked's `re` / `le` patterns) ---
// marked's inline-link and full-ref tokenizers only accept labels matching
// `re`: nested bracket pairs (2 levels), backslash escapes, code spans
// (whose content must contain NO backticks), a trailing backtick run right
// before ']', or single chars except [ ] \ `. A label with a code span
// whose content contains a backtick (e.g. `` `` a ` b `` ``) followed by
// more text does NOT match, so no link forms. Tested against label + "]".
const RE_LINK_LABEL = /^(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*\]$/;
// marked's ref label `le`: no unescaped '[', no whitespace-only ref, no
// newline followed by a blank line. Tested against refLabel + "]".
const RE_REF_LABEL = /^(?!\s*\])(?:\\[\s\S]|[^\[\]\\n]|\n(?![ \t]*\n))+\]$/;

function isValidLinkLabel(label) {
  // fast path: no '[', backslash or backtick means every char matches the
  // plain-char alternative (a ']' in the label always comes with its '[')
  if (label.indexOf("[") === -1 && label.indexOf("\\") === -1 && label.indexOf("`") === -1) return true;
  return RE_LINK_LABEL.test(label + "]");
}

function isMalformedRef(refLabel) {
  if (refLabel === "") return false; // collapsed, not malformed
  if (refLabel.indexOf("[") !== -1 || refLabel.indexOf("\n") !== -1) {
    return !RE_REF_LABEL.test(refLabel + "]");
  }
  return !/\S/.test(refLabel); // whitespace-only ref is malformed
}

function isEmailLocalChar(c) {
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
         (code >= 97 && code <= 122) || c === "." || c === "_" ||
         c === "+" || c === "-";
}

function backpedal(s) {
  let prev;
  do {
    prev = s;
    const m = RE_BACKPEDAL.exec(s);
    s = m ? m[0] : "";
  } while (s !== prev);
  return s;
}

// Match an email starting at the local part `start` (position of the first
// local char). Returns end position or -1. `bound` truncates the source
// the domain regex sees (used when the run ends at an emphasis closer).
function matchEmailAt(src, start, bound = src.length) {
  let i = start;
  while (i < bound && isEmailLocalChar(src[i])) i++;
  if (i === start || src[i] !== "@") return -1;
  RE_EMAIL_DOMAIN.lastIndex = i + 1;
  const m = RE_EMAIL_DOMAIN.exec(bound === src.length ? src : src.slice(0, bound));
  if (!m) return -1;
  return RE_EMAIL_DOMAIN.lastIndex;
}

// Match a www/scheme URL starting at `start` (the 'w' of www. or the scheme).
// Returns { end, href } or null.
function matchWwwSchemeAt(src, start, isWww) {
  const rest = src.slice(start);
  const m = isWww ? RE_WWW_DOMAIN.exec(rest.slice(4)) : RE_WWW_DOMAIN.exec(rest.slice(rest.indexOf("://") + 3));
  if (!m || m[0].length === 0) return null;
  let raw;
  if (isWww) raw = "www." + m[0];
  else raw = rest.slice(0, rest.indexOf("://") + 3) + m[0];
  raw = backpedal(raw);
  if (raw.length === 0) return null;
  // the backpedal must not cut into the scheme/www prefix or the first label
  const minLen = isWww ? 5 : rest.indexOf("://") + 4;
  if (raw.length < minLen) return null;
  return { end: start + raw.length, href: isWww ? "http://" + raw : raw, text: raw };
}

// Scan a text run [a, b) for GFM autolinks, pushing text/GFM nodes.
// `prevChar` is the char before position a in the full source ("" if none).
// Scan a run of plain text [a, b) for GFM autolinks (www./scheme/email).
// Returns the source position actually consumed, which may exceed `b`:
// marked's URL regex is unbounded (`[^\s<]*` + backpedal), so a URL may
// swallow a following `(`, `)`, `]`, `\` or backtick — e.g.
// `https://sub.domain.example.io)](https://npmjs.com/heading (Most))`
// autolinks as `https://sub.domain.example.io)]`. When `hardBound` is set
// (the run ends at a `]` that closes a link-forming bracket), the match
// must stay within the run: marked's link regex wins there, and the URL
// is link text, not an autolink. `linkCloseAt`, when given, is called
// with a `]` position to test whether it closes a link-forming bracket:
// a URL match that crosses such a `]` (even past intervening `*`/`_`
// delimiters) is rejected for the same reason.
function scanTextRun(src, a, b, nodes, delims, hardBound = false, linkCloseAt = null) {
  let pos = a;
  let textStart = a;
  // If the run ends at a '_' that will close an emphasis span, an email
  // ending at the run end must be matched as if the '_' were not there:
  // marked lexes the email inside the emphasis without the closer visible,
  // so the domain regex's (?![\w-]) lookahead must not see the '_'.
  // (A lone '_' with no opener is literal text and DOES backtrack the match.)
  let emailBoundCache = null;
  const getEmailBound = () => {
    if (emailBoundCache !== null) return emailBoundCache;
    emailBoundCache = src.length;
    if (b < src.length && src[b] === "_") {
      let runEnd = b;
      while (runEnd < src.length && src[runEnd] === "_") runEnd++;
      const prevCls = charClass(b === 0 ? "" : src[b - 1]);
      const nextCls = charClass(runEnd >= src.length ? "" : src[runEnd]);
      const leftFlank = nextCls !== 1 && (nextCls !== 2 || prevCls === 1 || prevCls === 2);
      const rightFlank = prevCls !== 1 && (prevCls !== 2 || nextCls === 1 || nextCls === 2);
      const canClose = rightFlank && (!leftFlank || nextCls === 2);
      if (canClose && delims.some((d) => d.ch === "_" && d.canOpen)) {
        emailBoundCache = b;
      }
    }
    return emailBoundCache;
  };
  const pushText = (from, to) => {
    if (to <= from) return;
    const s = src.slice(from, to);
    const last = nodes[nodes.length - 1];
    if (last && last.t === T_TEXT) last.s += s;
    else nodes.push({ t: T_TEXT, s });
  };
  // marked disables GFM autolinks entirely while inLink is set
  // (an unclosed `<a ` tag earlier in the document).
  if (docInLink) {
    pushText(a, b);
    return b;
  }
  while (pos < b) {
    // find the earliest trigger: www. | :// | @ | mailto: | xmpp:
    let best = -1, bestKind = 0;
    const w = src.indexOf("www.", pos);
    if (w !== -1 && w < b) { best = w; bestKind = 1; }
    const c = src.indexOf("://", pos);
    if (c !== -1 && c < b) {
      // scheme must end right before :// (http/https/ftp, case-insensitive)
      let schemeStart = -1;
      const before = src.slice(Math.max(a, c - 5), c).toLowerCase();
      if (before.endsWith("https")) schemeStart = c - 5;
      else if (before.endsWith("http")) schemeStart = c - 4;
      else if (before.endsWith("ftp")) schemeStart = c - 3;
      if (schemeStart >= pos && (best === -1 || schemeStart < best)) {
        best = schemeStart; bestKind = 2;
      }
    }
    // email: earliest @ at/after pos whose local part starts at/after pos
    let at = src.indexOf("@", pos);
    while (at !== -1 && at < b) {
      let ls = at;
      while (ls > pos && isEmailLocalChar(src[ls - 1])) ls--;
      if (ls < at) {
        if (best === -1 || ls < best) { best = ls; bestKind = 3; }
        break;
      }
      at = src.indexOf("@", at + 1);
    }
    const mt = src.indexOf("mailto:", pos);
    if (mt !== -1 && mt < b) {
      const pc = mt === 0 ? "" : src[mt - 1];
      if (!/[A-Za-z0-9]/.test(pc) && (best === -1 || mt < best)) { best = mt; bestKind = 4; }
    }
    const xm = src.indexOf("xmpp:", pos);
    if (xm !== -1 && xm < b) {
      const pc = xm === 0 ? "" : src[xm - 1];
      if (!/[A-Za-z0-9]/.test(pc) && (best === -1 || xm < best)) { best = xm; bestKind = 5; }
    }
    if (best === -1) break;
    let match = null;
    if (bestKind === 1) {
      // www. needs preceding start/space/*/_/~/(
      const pc = best === 0 ? "" : src[best - 1];
      if (pc === "" || pc === " " || pc === "\t" || pc === "\n" || pc === "*" || pc === "_" || pc === "~" || pc === "(") {
        match = matchWwwSchemeAt(src, best, true);
      }
    } else if (bestKind === 2) {
      match = matchWwwSchemeAt(src, best, false);
    } else if (bestKind === 3) {
      // the local part may extend before this run (a '_' splits runs):
      // scan back over the source to find the true local start
      let ls = best;
      while (ls > 0 && isEmailLocalChar(src[ls - 1])) ls--;
      const e = matchEmailAt(src, ls, getEmailBound());
      if (e !== -1 && e <= b) {
        // a mailto:/xmpp: prefix immediately before the local part belongs
        // to the link (it may sit in an earlier run, split by a '_')
        let linkStart = ls;
        let hasPrefix = false;
        if (ls >= 7 && src.slice(ls - 7, ls).toLowerCase() === "mailto:") {
          const pc = ls - 7 === 0 ? "" : src[ls - 8];
          if (!/[A-Za-z0-9]/.test(pc)) { linkStart = ls - 7; hasPrefix = true; }
        } else if (ls >= 5 && src.slice(ls - 5, ls).toLowerCase() === "xmpp:") {
          const pc = ls - 5 === 0 ? "" : src[ls - 6];
          if (!/[A-Za-z0-9]/.test(pc)) { linkStart = ls - 5; hasPrefix = true; }
        }
        if (linkStart < a) {
          // rewind the nodes covering [linkStart, a): the chars there are
          // only text and '_' delimiters
          let toRemove = a - linkStart;
          while (toRemove > 0 && nodes.length > 0) {
            const last = nodes[nodes.length - 1];
            if (last.t === T_TEXT) {
              if (last.s.length <= toRemove) { toRemove -= last.s.length; nodes.pop(); }
              else { last.s = last.s.slice(0, last.s.length - toRemove); toRemove = 0; }
            } else if (last.t === T_DELIM) {
              const runLen = last.n;
              if (runLen <= toRemove) {
                toRemove -= runLen;
                nodes.pop();
                const di = delims.indexOf(last);
                if (di !== -1) delims.splice(di, 1);
              } else {
                last.n -= toRemove;
                last.orig -= toRemove;
                toRemove = 0;
              }
            } else {
              break;
            }
          }
          best = linkStart;
        }
        let end = e;
        // xmpp: optional /resource
        if (hasPrefix && src.slice(linkStart, linkStart + 5).toLowerCase() === "xmpp:" && src[end] === "/") {
          let r = end + 1;
          while (r < b && /[A-Za-z0-9@.]/.test(src[r])) r++;
          if (r > end + 1) end = r;
        }
        const text = src.slice(linkStart, end);
        match = { end, href: hasPrefix ? text : "mailto:" + text, text };
      }
    } else if (bestKind === 4) {
      const e = matchEmailAt(src, best + 7, getEmailBound());
      if (e !== -1 && e <= b) match = { end: e, href: src.slice(best, e), text: src.slice(best, e) };
    } else if (bestKind === 5) {
      const e = matchEmailAt(src, best + 5, getEmailBound());
      if (e !== -1 && e <= b) {
        let end = e;
        // optional /resource
        if (src[end] === "/") {
          let r = end + 1;
          while (r < b && /[A-Za-z0-9@.]/.test(src[r])) r++;
          if (r > end + 1) end = r;
        }
        match = { end, href: src.slice(best, end), text: src.slice(best, end) };
      }
    }
    // www/scheme matches may extend past the run end (see header comment);
    // email matches are already bounded by their own `e <= b` checks.
    // A www/scheme match that crosses the first depth-0 `]` in its range
    // when that `]` closes a link-forming bracket is link text, not an
    // autolink (marked's link regex matches the whole `[...](...)`
    // first); the `]` that matters is the first at depth 0 — a later
    // `]` can never form the link because marked's label cannot contain
    // `]`, so only the first is tested.
    let crossesLink = false;
    if (match && match.end > b && (bestKind === 1 || bestKind === 2) && linkCloseAt) {
      let depth = 0;
      for (let k = best; k < match.end; k++) {
        const c = src[k];
        if (c === "\\") { k++; continue; }
        if (c === "[") depth++;
        else if (c === "]") {
          if (depth === 0) { crossesLink = linkCloseAt(k); break; }
          depth--;
        }
      }
    }
    if (match && (match.end <= b || !hardBound) && !crossesLink) {
      pushText(textStart, best);
      nodes.push({ t: T_GFM, href: match.href, text: match.text });
      pos = match.end;
      textStart = pos;
    } else {
      // no match at this trigger: advance past it and keep scanning
      // no match: advance past the trigger (always forward, never backward)
      pos = Math.max(best + 1, pos + 1);
      if (bestKind === 2) pos = Math.max(best + 4, pos); // skip past the scheme start
    }
  }
  pushText(textStart, b);
  return Math.max(b, pos);
}

// --- emphasis processing (delimiter stack) ---

function processEmphasis(nodes, delims) {
  // delims: delimiter nodes in `nodes`, in order. Marked does NOT use a
  // CommonMark delimiter stack: it scans FORWARD from each opener.
  // An opener of length k needs k closer delimiters (m); intervening
  // can-open-only runs ADD to the need, can-both runs may be skipped by
  // the rule of 3 (added to f), and the match consumes the whole closer
  // run — extra delimiters end up INSIDE the element, where marked
  // re-lexes them (so they are delimiter nodes here too, and the kids
  // are processed recursively). This is what makes `*a **b** c*` stay
  // literal (the inner `**` closer is rule-of-3-skipped, so m never
  // reaches 0) and `**a*b***` keep its trailing `*` inside the strong.
  const list = delims.slice();
  const idxOf = new Map();
  const rebuild = () => {
    idxOf.clear();
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].t === T_DELIM) idxOf.set(nodes[i], i);
    }
  };
  rebuild();
  // Is the delimiter at list index ci skipped by marked's closer-regex
  // `^...__...*...(?=__)` alternative (or its `_` mirror
  // `^...**..._...(?=**)`)? The candidate must be a lone delimiter
  // inside a pair of the other char: the pair's opener is exactly 2
  // long and is the first `*`/`_` delimiter after the opener, the
  // candidate is the next `*`/`_` delimiter after it, and the pair's
  // closer (2 or more long) is the next `*`/`_` delimiter after the
  // candidate. `~` delimiters do not break the pattern.
  const isSkippedByPair = (oi, ci, pairCh) => {
    if (list[ci].n !== 1) return false;
    let u1 = -1;
    for (let j = oi + 1; j < ci; j++) {
      if (list[j].ch === "~") continue;
      if (u1 !== -1) return false;
      u1 = j;
    }
    if (u1 === -1) return false;
    if (list[u1].ch !== pairCh || list[u1].n !== 2) return false;
    let u2 = -1;
    for (let j = ci + 1; j < list.length; j++) {
      if (list[j].ch === "~") continue;
      u2 = j;
      break;
    }
    if (u2 === -1) return false;
    if (list[u2].ch !== pairCh || list[u2].n < 2) return false;
    return true;
  };
  for (let oi = 0; oi < list.length; oi++) {
    const opener = list[oi];
    if (!opener.canOpen || opener.n === 0) continue;
    const ch = opener.ch;
    // `~` runs of 3+ never form del (marked's delLDelim cannot match
    // inside them, and del never retries) — the whole run stays literal
    if (ch === "~" && opener.orig > 2) continue;
    // Retry loop: if the scan fails and the run has more than one
    // delimiter left, consume one as literal text and retry the shorter
    // run (marked's lexer falls back to text and re-tries emStrong at
    // the next char — this is what makes `**foo*` render `*<em>foo</em>`).
    let midRun = opener.n < opener.orig;
    for (;;) {
      rebuild(); // indices may be stale after the previous match's splice
      const k = opener.n;               // opener length (remaining)
      const y = opener.orig;            // full opener run length
      const R = opener.canClose;        // opener can also close
      const o = midRun;                 // mid-run remainder
      let m = k, f = 0;
      let matchCloser = null, matchB = 0;
      let firstCand = true; // the pair-skip applies only to the 1st candidate
      for (let ci = oi + 1; ci < list.length; ci++) {
        const cand = list[ci];
        if (cand.ch !== ch || cand.n === 0) continue;
        if (!cand.canClose && !cand.canOpen) continue;
        if (firstCand) {
          firstCand = false;
          if (ch !== "~" && isSkippedByPair(oi, ci, ch === "*" ? "_" : "*")) continue;
        }
        const b = cand.n;
        if (ch === "~") {
          // del: the closer must have the same length as the opener
          // (no rule of 3 for del)
          if (b !== k) continue;
          if (cand.canOpen && !cand.canClose) { m += b; continue; }
          m -= b;
          if (m > 0) continue;
          matchCloser = cand;
          matchB = Math.min(b, b + m);
          break;
        }
        // * and _
        if (cand.canOpen && !cand.canClose) {
          m += b; continue; // can-open-only: add to the need
        } else if ((cand.canOpen && cand.canClose) || R) {
          if (o && cand.canOpen && cand.canClose) break; // mid-run opener
          if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; } // rule of 3: skip
        }
        m -= b;
        if (m > 0) continue;
        matchCloser = cand;
        matchB = Math.min(b, b + m + f);
        break;
      }
      if (!matchCloser) {
        // no match: consume one delimiter as literal text and retry
        // the shorter run (unless a single delimiter is left)
        if (ch !== "~" && opener.n > 1) {
          const oiPos = idxOf.get(opener);
          const prev = oiPos > 0 ? nodes[oiPos - 1] : null;
          if (prev && prev.t === T_TEXT) prev.s += ch;
          else nodes.splice(oiPos, 0, { t: T_TEXT, s: ch });
          opener.n -= 1;
          midRun = true;
          continue;
        }
        break; // stays literal
      }
      // form the element: em if min(k, matchB) is odd, else strong
      const use = ch === "~" ? k : (Math.min(k, matchB) % 2 === 1 ? 1 : 2);
      const tag = ch === "~" ? "del" : use === 2 ? "strong" : "em";
      const oiPos = idxOf.get(opener);
      const ciPos = idxOf.get(matchCloser);
      const kids = nodes.slice(oiPos + 1, ciPos);
      // extra delimiters go INSIDE as delimiter nodes (marked re-lexes the
      // inner text): the opener's extra sits at the start (prev = start,
      // so it can open but not close), the closer's extra at the end
      // (next = end, so it can close but not open).
      const extraOpen = k > use
        ? { t: T_DELIM, ch, n: k - use, orig: k - use, canOpen: opener.canOpen, canClose: false }
        : null;
      const extraClose = matchB > use
        ? { t: T_DELIM, ch, n: matchB - use, orig: matchB - use, canOpen: false, canClose: matchCloser.canClose }
        : null;
      if (extraOpen) kids.unshift(extraOpen);
      if (extraClose) kids.push(extraClose);
      // recursively process inner emphasis (marked re-lexes the inner text)
      const kidSet = new Set(kids);
      const kidDelims = [];
      for (const d of list) {
        if (d !== opener && d !== matchCloser && kidSet.has(d)) kidDelims.push(d);
      }
      if (extraOpen) kidDelims.unshift(extraOpen);
      if (extraClose) kidDelims.push(extraClose);
      if (kidDelims.length > 0) processEmphasis(kids, kidDelims);
      const em = { t: T_EM, tag, kids };
      // the opener is fully consumed; the closer keeps its unconsumed rest
      const closerLeft = matchCloser.n - matchB;
      matchCloser.n = closerLeft;
      opener.n = 0;
      const replacement = [em];
      if (closerLeft > 0) replacement.push(matchCloser);
      nodes.splice(oiPos, ciPos - oiPos + 1, ...replacement);
      // remove the opener, the trapped delimiters, and (if exhausted) the
      // closer from the list
      const removeSet = new Set(kidDelims);
      removeSet.add(opener);
      if (closerLeft === 0) removeSet.add(matchCloser);
      for (let x = list.length - 1; x >= 0; x--) {
        if (removeSet.has(list[x])) {
          list.splice(x, 1);
          if (x <= oi) oi--;
        }
      }
      rebuild();
      break; // done with this opener
    }
  }
}

/* ---------------- inline link parsing ---------------- */

// Parse an inline link destination + title starting at src[pos] === '('.
// Returns { dest, title, end } (end = index just past ')') or null.
function parseInlineLink(src, pos) {
  let i = pos + 1;
  // skip whitespace (spaces, tabs, newlines)
  while (i < src.length && (src[i] === " " || src[i] === "\t" || src[i] === "\n")) i++;
  if (i >= src.length) return null;
  // empty destination
  if (src[i] === ")") return { dest: "", title: null, end: i + 1 };
  // try angle destination first
  if (src[i] === "<") {
    let j = i + 1;
    let ok = false;
    while (j < src.length) {
      const c = src[j];
      if (c === "\\" && j + 1 < src.length) { j += 2; continue; }
      if (c === "\n" || c === "<") break;
      if (c === ">") { ok = true; break; }
      j++;
    }
    if (ok) {
      const dest = unescapeStr(collapseWs(src.slice(i + 1, j)));
      const after = parseTitleAndClose(src, j + 1);
      if (after) return { dest, title: after.title, end: after.end };
      // fall through to bare-destination parse
    }
  }
  // bare destination: no spaces, balanced parens
  {
    let depth = 0;
    let j = i;
    while (j < src.length) {
      const c = src[j];
      if (c === " " || c === "\t" || c === "\n") break;
      const code = c.charCodeAt(0);
      if (code < 0x20) break;
      if (c === "\\" && j + 1 < src.length && ASCII_PUNCT.has(src[j + 1])) { j += 2; continue; }
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    if (j === i) return null; // no destination
    let dest = src.slice(i, j);
    if (dest.charAt(0) === "<") {
      // must end with an unescaped >
      if (!dest.endsWith(">")) return null;
      let bs = 0;
      for (let k = dest.length - 2; k >= 0 && dest[k] === "\\"; k--) bs++;
      if (bs % 2 === 1) return null;
      dest = dest.slice(1, -1);
    }
    dest = unescapeStr(dest);
    const after = parseTitleAndClose(src, j);
    if (after) return { dest, title: after.title, end: after.end };
    return null;
  }
}

// After a destination: parse optional title and the closing ')'.
// Returns { title, end } or null.
function parseTitleAndClose(src, pos) {
  let i = pos;
  // separator: spaces/tabs (with at most one newline) or a newline
  let sepStart = i;
  let hasWs = false;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) { i++; hasWs = true; }
  if (src[i] === "\n") {
    i++;
    hasWs = true;
    while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  }
  if (i >= src.length) return null;
  if (src[i] === ")") return { title: null, end: i + 1 };
  if (!hasWs) return null;
  // title?
  const q = src[i];
  let title = null;
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\" && j + 1 < src.length) { j += 2; continue; }
      if (src[j] === q) break;
      j++;
    }
    if (j >= src.length) return null;
    title = unescapeStr(src.slice(i + 1, j));
    i = j + 1;
  } else if (q === "(") {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\" && j + 1 < src.length) { j += 2; continue; }
      if (src[j] === "(") return null; // no nested parens in title
      if (src[j] === ")") break;
      j++;
    }
    if (j >= src.length) return null;
    title = unescapeStr(src.slice(i + 1, j));
    i = j + 1;
  } else {
    return null;
  }
  // trailing whitespace then ')'
  while (i < src.length && (src[i] === " " || src[i] === "\t" || src[i] === "\n")) i++;
  if (src[i] !== ")") return null;
  return { title, end: i + 1 };
}

/* ---------------- the inline tokenizer ---------------- */

// marked's emStrongMask helpers (see computeBlockSkipMasks): the "fixed"
// text replaces inner backticks inside code spans and escaped punctuation
// with `+` (length-preserving), so blockSkip's patterns can match a
// `[...](...)` whose label holds a code span with a stray backtick, and
// so its code-span alternative pairs backtick runs greedily.
const RE_MASK_FIX = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const RE_BLOCKSKIP = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)(`+)[^`]+\2(?!`)|<(?! )[^<>]*?>/g;

// Find the constructs marked's emStrongMask hides from emphasis scanning
// (blockSkip's link + code + html patterns on the fixed text). Returns
// { linkRanges, codeRanges } ([start, end) spans). Link ranges feed the
// no-link mask (see tryResolve); code ranges hide delimiters from the
// main emphasis pass (blockSkip pairs backtick runs greedily, so a
// "code span" here can span across a link's `](...)` part and cover
// text my tokenizer sees as plain — e.g. `_issue table_` after a link
// whose label holds a stray backtick). Html matches are ignored
// (delimiters inside tags never reach the delimiter list).
function computeBlockSkipMasks(src) {
  const out = { linkRanges: [], codeRanges: [] };
  if (src.indexOf("`") === -1 && src.indexOf("](") === -1) return out;
  const fixed = src.replace(RE_MASK_FIX, (m, ticks, esc) => {
    if (esc) return "+".repeat(m.length);
    if (ticks) return ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, "+") + ticks;
    return m;
  });
  RE_BLOCKSKIP.lastIndex = 0;
  let m;
  while ((m = RE_BLOCKSKIP.exec(fixed)) !== null) {
    const range = [m.index, m.index + m[0].length];
    if (m[0][0] === "[") out.linkRanges.push(range);
    else if (m[0][0] === "`") out.codeRanges.push(range);
  }
  return out;
}

const RE_SPECIAL = /[\\`*_\[\]<!~\n]/g;

// marked's document-wide inLink state: an inline `<a ` tag (open tag with
// a space after `a`, case-insensitive) disables GFM autolinks until a
// `</a>` tag (exactly) closes it. Bare `<a>`, `<a\t`, `<a\n` and `</a >`
// do NOT toggle it. The state persists across blocks for the whole
// document (an unclosed `<a>` in one paragraph disables autolinks in
// every later paragraph). Reset at the start of each parse() call.
let docInLink = false;

// Parse inline content into a node list (emphasis processed, links resolved).
function inlineParse(src, refs) {
  const nodes = [];
  const delims = [];
  const brackets = []; // stack of { node, img, active, srcPos }
  // spans where top-level emphasis delimiters are suppressed (marked's
  // emStrongMask quirk: see tryResolve)
  const suppressRanges = [];
  // blockSkip link matches (marked's emStrongMask): a matched
  // `[...](...)` that does NOT form a link has its label delimiters
  // masked — they are literal text (see tryResolve's no-link branch).
  // A matched construct that DOES form a link is re-lexed in its own
  // scope, so its label delimiters stay visible. BlockSkip code matches
  // hide delimiters from the main emphasis pass (added to suppressRanges
  // below); html matches are ignored.
  const { linkRanges: maskRanges, codeRanges } = computeBlockSkipMasks(src);
  for (const r of codeRanges) suppressRanges.push(r);
  const len = src.length;
  let i = 0;
  RE_SPECIAL.lastIndex = 0;

  const flushRun = (from, to, hardBound = false) => {
    if (to > from) return scanTextRun(src, from, to, nodes, delims, hardBound, bracketFormsLink);
    return to;
  };

  // Convert GFM autolink nodes inside `kids` back to plain text nodes
  // (GFM autolinks are disabled inside link/image text).
  const demoteGfm = (kids) => {
    for (let k = 0; k < kids.length; k++) {
      if (kids[k].t === T_GFM) kids[k] = { t: T_TEXT, s: kids[k].text };
    }
  };

  // Resolve a link/image at the current ']' (position i). Returns the index
  // just past the consumed suffix, or -1 if no link forms.
  // Would the innermost open bracket form a link if `bound` were its
  // closing ']'? Mirrors tryResolve's decision (used by the code-span
  // boundary check: a code span may only cross the label's ']' when no
  // link forms from the bracket).
  const bracketFormsLink = (bound) => {
    const br = brackets[brackets.length - 1];
    if (!br || !br.active) return false;
    const labelRaw = src.slice(br.srcPos + (br.img ? 2 : 1), bound);
    const after = bound + 1;
    const shortcut = () => {
      const key = normalizeLabel(labelRaw);
      return key !== "" && refs[key] !== undefined;
    };
    if (src[after] === "(") {
      const inl = parseInlineLink(src, after);
      if (inl && isValidLinkLabel(labelRaw)) return true;
      return shortcut();
    }
    if (src[after] === "[") {
      const close2 = src.indexOf("]", after + 1);
      if (close2 !== -1) {
        const refLabel = src.slice(after + 1, close2);
        if (refLabel === "") return shortcut();
        if (isMalformedRef(refLabel) || !isValidLinkLabel(labelRaw)) return shortcut();
        const key = normalizeLabel(refLabel);
        return key !== "" && refs[key] !== undefined;
      }
      return shortcut();
    }
    return shortcut();
  };

  const tryResolve = (closePos) => {
    // A ']' belongs to the topmost bracket on the stack (by nesting). If
    // that bracket was deactivated (by a link forming inside it), the ']'
    // is literal and the bracket is dropped — an outer bracket cannot
    // claim this ']'.
    if (brackets.length === 0) return -1;
    const bi = brackets.length - 1;
    const br = brackets[bi];
    if (!br.active) {
      brackets.splice(bi, 1);
      return -1;
    }
    const brIdx = nodes.indexOf(br.node);
    // raw label text between '[' and ']' (for shortcut/collapsed lookup)
    const labelRaw = src.slice(br.srcPos + (br.img ? 2 : 1), closePos);
    let dest = null, title = null, endPos = -1;
    const after = closePos + 1;
    if (src[after] === "(") {
      const inl = parseInlineLink(src, after);
      // an invalid label (per marked's `re`) means the link tokenizer
      // never matches: fall back to the shortcut reference, as if the
      // inline parse had failed
      if (inl && isValidLinkLabel(labelRaw)) {
        dest = inl.dest; title = inl.title; endPos = inl.end;
      } else {
        // inline parse failed (or label invalid): fall back to shortcut
        const key = normalizeLabel(labelRaw);
        const ref = key === "" ? undefined : refs[key];
        if (ref) { dest = ref.dest; title = ref.title; endPos = after; }
      }
    } else if (src[after] === "[") {
      // full or collapsed reference
      const close2 = src.indexOf("]", after + 1);
      if (close2 !== -1) {
        const refLabel = src.slice(after + 1, close2);
        if (refLabel === "") {
          // collapsed: the label is validated by `le`, not `re`
          const key = normalizeLabel(labelRaw);
          const ref = key === "" ? undefined : refs[key];
          if (ref) { dest = ref.dest; title = ref.title; endPos = close2 + 1; }
        } else if (isMalformedRef(refLabel) || !isValidLinkLabel(labelRaw)) {
          // malformed ref or invalid label: marked's reflink fails and
          // the shortcut (nolink) gets its chance
          const key = normalizeLabel(labelRaw);
          const ref = key === "" ? undefined : refs[key];
          if (ref) { dest = ref.dest; title = ref.title; endPos = after; }
        } else {
          const key = normalizeLabel(refLabel);
          const ref = key === "" ? undefined : refs[key];
          if (ref) { dest = ref.dest; title = ref.title; endPos = close2 + 1; }
          // well-formed ref with no def: no fallback
        }
      } else {
        // no closing ']' for the ref: reflink fails, try the shortcut
        const key = normalizeLabel(labelRaw);
        const ref = key === "" ? undefined : refs[key];
        if (ref) { dest = ref.dest; title = ref.title; endPos = after; }
      }
    } else {
      // shortcut reference
      const key = normalizeLabel(labelRaw);
      const ref = key === "" ? undefined : refs[key];
      if (ref) { dest = ref.dest; title = ref.title; endPos = after; }
    }
    if (dest === null) {
      // no link forms: this bracket is used up (it consumed its ']');
      // drop it so it cannot match a later ']'
      // marked's emStrongMask quirk (Category A): if this `[...](...)`
      // matched blockSkip's link pattern, its label delimiters were
      // masked in marked's main pass and are never re-lexed (no link
      // formed), so they are literal text. Remove them from the
      // delimiter list and convert their nodes to plain text.
      const openPos = br.srcPos + (br.img ? 1 : 0);
      if (maskRanges.some(([s]) => s === openPos)) {
        for (let k = brIdx + 1; k < nodes.length; k++) {
          const n = nodes[k];
          if (n.t === T_DELIM) {
            n.t = T_TEXT;
            n.s = n.ch.repeat(n.n);
            const di = delims.indexOf(n);
            if (di !== -1) delims.splice(di, 1);
          }
        }
      }
      brackets.splice(bi, 1);
      return -1;
    }
    // marked's emStrongMask quirk: its blockSkip code pattern pairs a
    // stray backtick run in a link label (one with no closer inside the
    // label) with the next same-length backtick run after the link, and
    // masks everything between — so emphasis delimiters in that span
    // are invisible. Replicate by suppressing top-level delimiters in
    // the span [last unpaired backtick run in the label, its later pair).
    if (labelRaw.indexOf("`") !== -1) {
      const labelStart = br.srcPos + (br.img ? 2 : 1);
      const runs = [];
      for (let k = 0; k < labelRaw.length; k++) {
        if (labelRaw[k] === "`") {
          let r = 1;
          while (k + r < labelRaw.length && labelRaw[k + r] === "`") r++;
          runs.push({ pos: labelStart + k, len: r });
          k += r - 1;
        }
      }
      // greedy pairing of adjacent equal-length runs (blockSkip's rule:
      // a code span's closer must be the immediately-next run)
      let ri = 0;
      while (ri + 1 < runs.length) {
        if (runs[ri + 1].len === runs[ri].len) ri += 2;
        else ri++;
      }
      if (ri === runs.length - 1) {
        const last = runs[ri];
        const q = src.indexOf("`", last.pos + last.len);
        if (q !== -1) {
          let qlen = 1;
          while (q + qlen < len && src[q + qlen] === "`") qlen++;
          if (qlen === last.len) suppressRanges.push([last.pos, q + qlen]);
        }
      }
    }
    // form the link/image: kids = nodes between bracket and ']'
    const kids = nodes.slice(brIdx + 1);
    const kidCount = kids.length; // captured BEFORE processEmphasis shrinks kids
    // remove kids' delimiters from the top-level delimiter list
    const kidDelims = [];
    const kidSet = new Set(kids);
    for (let d = delims.length - 1; d >= 0; d--) {
      if (kidSet.has(delims[d])) { kidDelims.push(delims[d]); delims.splice(d, 1); }
    }
    kidDelims.reverse();
    demoteGfm(kids);
    // emphasis is processed inside both links and images (image alt text
    // flattens it, so ![foo *bar*] has alt "foo bar")
    processEmphasis(kids, kidDelims);
    if (!br.img) {
      nodes.splice(brIdx, kidCount + 1, { t: T_LINK, href: dest, title, kids });
      // a link formed: deactivate outer LINK brackets (no nested links),
      // but outer image brackets stay active (alt text may contain links)
      for (let b = 0; b < bi; b++) if (!brackets[b].img) brackets[b].active = false;
    } else {
      nodes.splice(brIdx, kidCount + 1, { t: T_IMAGE, href: dest, title, kids });
      // an image forming deactivates nothing
    }
    brackets.splice(bi, 1);
    return endPos;
  };

  while (i < len) {
    RE_SPECIAL.lastIndex = i;
    const m = RE_SPECIAL.exec(src);
    const next = m ? m.index : len;
    if (next > i) {
      // a run ending at a `]` that closes a link-forming bracket is
      // hard-bounded: a URL inside the label must not swallow the `]`
      const hardBound = next < len && src[next] === "]" && bracketFormsLink(next);
      i = flushRun(i, next, hardBound);
      if (i >= len) break;
    }
    const ch = src[i];
    if (ch === "\n") {
      // hard break? 2+ spaces at end of pending text, and not at end of input
      const last = nodes[nodes.length - 1];
      let isHard = false;
      if (last && last.t === T_TEXT) {
        const s = last.s;
        if (s.length >= 2 && s.endsWith("  ")) {
          // rest after \n must not be all whitespace
          let k = i + 1;
          while (k < len && (src[k] === " " || src[k] === "\t" || src[k] === "\n")) k++;
          if (k < len) isHard = true;
        }
      }
      if (isHard) {
        // strip the trailing spaces
        const s = last.s;
        let cut = s.length;
        while (cut > 0 && s[cut - 1] === " ") cut--;
        last.s = s.slice(0, cut);
        if (last.s === "") nodes.pop();
        nodes.push({ t: T_BR });
        i++;
        while (i < len && (src[i] === " " || src[i] === "\t")) i++;
      } else {
        // soft break: literal newline in text
        const last2 = nodes[nodes.length - 1];
        if (last2 && last2.t === T_TEXT) last2.s += "\n";
        else nodes.push({ t: T_TEXT, s: "\n" });
        i++;
      }
      continue;
    }
    if (ch === "\\") {
      const nx = src[i + 1];
      if (nx === "\n") {
        // backslash hard break (if not at end)
        let k = i + 2;
        while (k < len && (src[k] === " " || src[k] === "\t" || src[k] === "\n")) k++;
        if (k < len) {
          nodes.push({ t: T_BR });
          i += 2;
          while (i < len && (src[i] === " " || src[i] === "\t")) i++;
        } else {
          // literal backslash; the \n becomes text
          const last = nodes[nodes.length - 1];
          if (last && last.t === T_TEXT) last.s += "\\";
          else nodes.push({ t: T_TEXT, s: "\\" });
          i++;
        }
      } else if (nx !== undefined && ASCII_PUNCT.has(nx)) {
        // escaped char: its own node, rendered with escAll, never merged
        // into adjacent text (else \&ouml; would look like an entity)
        nodes.push({ t: T_ESC, s: nx });
        i += 2;
      } else {
        const last = nodes[nodes.length - 1];
        if (last && last.t === T_TEXT) last.s += "\\";
        else nodes.push({ t: T_TEXT, s: "\\" });
        i++;
      }
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (i + run < len && src[i + run] === "`") run++;
      // find a closing run of exactly `run` backticks
      let close = -1;
      let j = i + run;
      while (j < len) {
        const bq = src.indexOf("`", j);
        if (bq === -1) break;
        let r2 = 1;
        while (bq + r2 < len && src[bq + r2] === "`") r2++;
        if (r2 === run) { close = bq; break; }
        j = bq + r2;
      }
      if (close !== -1 && brackets.length > 0) {
        // Find the first ']' between the opener and the closer that is
        // not matched by a '[' opened after the opener: the label's
        // closing ']'. A code span may not cross it — but ONLY if a link
        // actually forms from this bracket (marked's link tokenizer runs
        // first; if the label is invalid, no link forms and the code span
        // crosses freely, e.g. `[not a `link](/foo`)`).
        let depth = 0, bound = -1;
        for (let k = i + run; k < close; k++) {
          const c = src[k];
          if (c === "\\") { k++; continue; }
          if (c === "[") depth++;
          else if (c === "]") {
            if (depth === 0) { bound = k; break; }
            depth--;
          }
        }
        if (bound !== -1 && bracketFormsLink(bound)) close = -1;
      }
      if (close === -1) {
        // literal backticks
        const s = "`".repeat(run);
        const last = nodes[nodes.length - 1];
        if (last && last.t === T_TEXT) last.s += s;
        else nodes.push({ t: T_TEXT, s });
        i += run;
      } else {
        let content = src.slice(i + run, close).replace(/\n/g, " ");
        if (content.length >= 2 && content[0] === " " && content[content.length - 1] === " " && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        nodes.push({ t: T_CODE, s: content });
        i = close + run;
      }
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      let run = 1;
      while (i + run < len && src[i + run] === ch) run++;
      // suppressed by a link-label backtick mask (marked's emStrongMask
      // quirk): a top-level delimiter inside the masked span is literal
      // text, not a delimiter (label delimiters are lexed in their own
      // scope in marked, so they are never suppressed)
      if (brackets.length === 0 && suppressRanges.length > 0) {
        let suppressed = false;
        for (let s = 0; s < suppressRanges.length; s++) {
          if (i >= suppressRanges[s][0] && i < suppressRanges[s][1]) { suppressed = true; break; }
        }
        if (suppressed) {
          const s = ch.repeat(run);
          const last = nodes[nodes.length - 1];
          if (last && last.t === T_TEXT) last.s += s;
          else nodes.push({ t: T_TEXT, s });
          i += run;
          continue;
        }
      }
      const prev = i === 0 ? "" : src[i - 1];
      const nextCh = i + run >= len ? "" : src[i + run];
      const prevCls = charClass(prev);
      const nextCls = charClass(nextCh);
      const leftFlank = nextCls !== 1 && (nextCls !== 2 || prevCls === 1 || prevCls === 2);
      const rightFlank = prevCls !== 1 && (prevCls !== 2 || nextCls === 1 || nextCls === 2);
      let canOpen, canClose;
      if (ch === "_") {
        canOpen = leftFlank && (!rightFlank || prevCls === 2);
        canClose = rightFlank && (!leftFlank || nextCls === 2);
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      const d = { t: T_DELIM, ch, n: run, orig: run, canOpen, canClose };
      nodes.push(d);
      delims.push(d);
      i += run;
      continue;
    }
    if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const img = ch === "!";
      const node = { t: T_BRACKET, img, active: true };
      nodes.push(node);
      brackets.push({ node, img, active: true, srcPos: i });
      i += img ? 2 : 1;
      continue;
    }
    if (ch === "]") {
      const endPos = tryResolve(i);
      if (endPos !== -1) {
        i = endPos;
      } else {
        const last = nodes[nodes.length - 1];
        if (last && last.t === T_TEXT) last.s += "]";
        else nodes.push({ t: T_TEXT, s: "]" });
        i++;
      }
      continue;
    }
    if (ch === "<") {
      const tag = matchTagOrAuto(src, i);
      if (tag) {
        // a tag/autolink containing ']' kills all open brackets (the 'Be' rule)
        if (brackets.length > 0 && src.indexOf("]", i) !== -1 && src.indexOf("]", i) < tag.end) {
          for (const b of brackets) b.active = false;
        }
        if (tag.isAuto) {
          nodes.push({ t: T_AUTO, href: tag.href, text: tag.text });
        } else {
          const tagText = src.slice(i, tag.end);
          // marked's inLink toggle: `<a ` opens, `</a>` closes
          // (bare `<a>` and `</a >` do neither — see docInLink).
          if (/^<a /i.test(tagText)) docInLink = true;
          else if (/^<\/a>/i.test(tagText)) docInLink = false;
          nodes.push({ t: T_HTML, s: tagText });
        }
        i = tag.end;
      } else {
        const last = nodes[nodes.length - 1];
        if (last && last.t === T_TEXT) last.s += "<";
        else nodes.push({ t: T_TEXT, s: "<" });
        i++;
      }
      continue;
    }
    // '!' not followed by '[': plain text
    const last = nodes[nodes.length - 1];
    if (last && last.t === T_TEXT) last.s += ch;
    else nodes.push({ t: T_TEXT, s: ch });
    i++;
  }
  processEmphasis(nodes, delims);
  return nodes;
}

/* ---------------- inline rendering ---------------- */

function renderInline(nodes) {
  let out = "";
  for (const n of nodes) {
    switch (n.t) {
      case T_TEXT: out += renderText(n.s); break;
      case T_ESC: out += escAll(n.s); break;
      case T_CODE: out += "<code>" + escAll(n.s) + "</code>"; break;
      case T_HTML: out += n.s; break;
      case T_BR: out += "<br>"; break;
      case T_DELIM: out += n.ch.repeat(n.n); break;
      case T_BRACKET: out += n.img ? "![" : "["; break;
      case T_EM: out += "<" + n.tag + ">" + renderInline(n.kids) + "</" + n.tag + ">"; break;
      case T_LINK: {
        const url = cleanUrl(n.href);
        if (url === null) { out += renderInline(n.kids); break; }
        out += '<a href="' + escNoEnc(url) + '"';
        if (n.title) out += ' title="' + escNoEnc(n.title) + '"';
        out += ">" + renderInline(n.kids) + "</a>";
        break;
      }
      case T_IMAGE: {
        const alt = renderAltText(n.kids);
        const url = cleanUrl(n.href);
        if (url === null) { out += escNoEnc(alt); break; }
        out += '<img src="' + escNoEnc(url) + '" alt="' + escNoEnc(alt) + '"';
        if (n.title) out += ' title="' + escNoEnc(n.title) + '"';
        out += ">";
        break;
      }
      case T_GFM: {
        const url = cleanUrl(n.href);
        out += '<a href="' + escAll(url) + '">' + escAll(n.text) + "</a>";
        break;
      }
      case T_AUTO: {
        const url = cleanUrl(n.href);
        out += '<a href="' + escAll(url) + '">' + escAll(n.text) + "</a>";
        break;
      }
    }
  }
  return out;
}

// TextRenderer for image alt text: raw text, no escaping, no <br>.
function renderAltText(nodes) {
  let out = "";
  for (const n of nodes) {
    switch (n.t) {
      case T_TEXT: out += decodeText(n.s); break;
      case T_ESC: out += n.s; break;
      case T_CODE: out += n.s; break;
      case T_HTML: out += n.s; break;
      case T_BR: break;
      case T_DELIM: out += n.ch.repeat(n.n); break;
      case T_BRACKET: out += n.img ? "![" : "["; break;
      case T_EM: out += renderAltText(n.kids); break;
      case T_LINK: out += renderAltText(n.kids); break;
      case T_IMAGE: out += renderAltText(n.kids); break;
      case T_GFM: out += n.text; break;
      case T_AUTO: out += n.text; break;
    }
  }
  return out;
}

/* ---------------- block parsing ---------------- */

// Block node kinds: para, heading, code, hr, quote, list, table, html.
// para: { kind, text } — text is the raw paragraph source (lines joined \n).
// heading: { kind, depth, text } — inline source.
// code: { kind, text, lang } — text ends with \n if non-empty; lang may be "".
// hr: { kind }
// quote: { kind, children }
// list: { kind, ordered, start, loose, items: [{ children, task }] }
//   task: null | " " | "x" (checkbox state)
// table: { kind, header: [cells], align: [""|"left"|"center"|"right"], rows: [[cells]] }
// html: { kind, text } — raw HTML block source.

const BLOCK_TAGS = new Set(
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(" "),
);

// Expand tabs in `s` assuming it starts at column `col`. Returns the
// expanded string.
function expandTabs(s, col) {
  if (s.indexOf("\t") === -1) return s;
  let out = "";
  let c = col;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\t") {
      const n = 4 - (c % 4);
      out += " ".repeat(n);
      c += n;
    } else {
      out += s[i];
      c++;
    }
  }
  return out;
}

// Column width of the leading whitespace of `line` (tabs expand to 4).
// Returns { indent, idx } where idx is the index of the first non-space char.
function lineIndent(line) {
  let indent = 0;
  let idx = 0;
  while (idx < line.length) {
    const c = line[idx];
    if (c === " ") { indent++; idx++; }
    else if (c === "\t") { indent += 4 - (indent % 4); idx++; }
    else break;
  }
  return { indent, idx };
}

// Remove `n` columns of indent from the start of `line` (tab-aware).
// Tabs beyond the stripped region are PRESERVED (used for code content:
// fenced/indented code keeps its tabs). A tab straddling the boundary
// is removed ENTIRELY (marked's fence-indent stripping drops a tab that
// crosses the indent edge instead of turning its excess into spaces —
// verified: fence indent 2 + a bare-tab content line yields 0 spaces).
// (For n=4 the straddling case cannot occur: a tab starting before
// column 4 always ends exactly at column 4.)
function stripIndent(line, n) {
  let col = 0;
  let idx = 0;
  while (idx < line.length && col < n) {
    const c = line[idx];
    if (c === " ") { col++; idx++; }
    else if (c === "\t") {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; idx++; }
      else {
        // straddling tab: marked drops it entirely
        return line.slice(idx + 1);
      }
    } else break;
  }
  return line.slice(idx);
}

// Strip one indented-code indent the way marked's codeRemoveIndent does:
// 0-3 spaces + a tab, or 1-4 spaces.
function stripCodeIndent(line) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  if (line[i] === "\t") return line.slice(i + 1);
  let j = 0;
  while (j < 4 && line[j] === " ") j++;
  return line.slice(j);
}

// Remove `n` columns of indent, expanding ALL leading tabs to spaces first
// (used for container content: list items strip their content indent with
// tabs expanded, per marked's list handling).
function stripIndentExpand(line, n) {
  let col = 0, out = "", i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    if (line[i] === "\t") { const w = 4 - (col % 4); out += " ".repeat(w); col += w; }
    else { out += " "; col++; }
    i++;
  }
  const wsLen = out.length;
  out += line.slice(i);
  return out.slice(Math.min(n, wsLen));
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// --- block-start detectors (on a line's content after up-to-3 indent) ---

function matchAtx(line, idx) {
  // idx = index of first non-space char; indent < 4 required (checked by caller)
  let n = 0;
  while (line[idx + n] === "#") n++;
  if (n === 0 || n > 6) return null;
  const after = line[idx + n];
  if (after !== undefined && after !== " " && after !== "\t" && after !== "\n") return null;
  let text = line.slice(idx + n).trim();
  // strip closing hashes (only if preceded by space/tab, or the whole text is hashes)
  if (/#$/.test(text)) {
    const stripped = text.replace(/ +#+$/, "").replace(/^#+$/, "");
    // only strip if the hashes were preceded by a space or are the whole text
    if (text === stripped + "#".repeat(text.length - stripped.length) && (stripped === "" || /[ \t]$/.test(text.slice(0, text.length - (text.length - stripped.length))))) {
      text = stripped.trim();
    } else {
      const m = text.match(/^(.*?) +#+$/);
      if (m) text = m[1].trim();
    }
  }
  return { depth: n, text };
}

function matchFence(line, idx) {
  const c = line[idx];
  if (c !== "`" && c !== "~") return null;
  let n = 0;
  while (line[idx + n] === c) n++;
  if (n < 3) return null;
  const info = line.slice(idx + n);
  if (c === "`" && info.indexOf("`") !== -1) return null;
  return { char: c, len: n, info: info.trim() };
}

function matchHr(line, idx) {
  const rest = line.slice(idx);
  const m = /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/.exec(rest);
  return m ? true : null;
}

function matchSetext(line, idx) {
  const rest = line.slice(idx);
  const m = /^([=-]+)[ \t]*$/.exec(rest);
  if (!m) return null;
  return m[1][0] === "=" ? 1 : 2;
}

function matchBlockquote(line, idx) {
  return line[idx] === ">";
}

// Match a list marker at idx. Returns { ordered, start, markerLen, delim }
// or null.
function matchListMarker(line, idx) {
  const c = line[idx];
  if (c === "-" || c === "+" || c === "*") {
    const after = line[idx + 1];
    if (after === undefined || after === " " || after === "\t" || after === "\n") {
      return { ordered: false, start: 0, markerLen: 1, bullet: c };
    }
    return null;
  }
  if (c >= "0" && c <= "9") {
    let j = idx;
    while (j < line.length && line[j] >= "0" && line[j] <= "9") j++;
    if (j - idx > 9) return null;
    const d = line[j];
    if (d !== "." && d !== ")") return null;
    const after = line[j + 1];
    if (after !== undefined && after !== " " && after !== "\t" && after !== "\n") return null;
    return { ordered: true, start: parseInt(line.slice(idx, j), 10), markerLen: j - idx + 1, delim: d };
  }
  return null;
}

// Match an HTML block start at idx (indent < 4). Returns the block type
// 1-7, or null. Type 1: pre/script/style/textarea. Type 2: comment.
// Type 3: ?. Type 4: declaration. Type 5: CDATA. Type 6: block tag.
// Type 7: any other tag (complete on the line).
function matchHtmlBlock(line, idx) {
  if (line[idx] !== "<") return null;
  const rest = line.slice(idx);
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m1) return { type: 1, tag: m1[1].toLowerCase() };
  if (/^<!--/.test(rest)) return { type: 2 };
  if (/^<\?/.test(rest)) return { type: 3 };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4 };
  if (/^<!\[CDATA\[/.test(rest)) return { type: 5 };
  const m6o = /^<([A-Za-z][A-Za-z0-9-]*)(?: +|$|\/?>)/.exec(rest);
  const m6c = /^<\/([A-Za-z][A-Za-z0-9-]*)(?:\s*>|$)/.exec(rest);
  const m6 = m6o || m6c;
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6 };
  // type 7: any other tag complete on the line (closing tags take no attributes)
  const m7o = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>[ \t]*$/.test(rest);
  const m7c = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/.test(rest);
  if (m7o || m7c) return { type: 7 };
  return null;
}

// Table delimiter row: returns array of alignments, or null.
function matchTableDelimiter(line, idx) {
  const rest = line.slice(idx);
  if (!/[:|]/.test(rest)) return null;
  // split into cells on unescaped pipes
  const cells = splitTableRow(rest, 0);
  if (cells === null) return null;
  const align = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (/^ *-+: *$/.test(c)) align.push("right");
    else if (/^ *:-+: *$/.test(c)) align.push("center");
    else if (/^ *:-+ *$/.test(c)) align.push("left");
    else if (/^ *- *$/.test(c) || /^-+$/.test(c)) align.push("");
    else return null;
  }
  if (align.length === 0) return null;
  return align;
}

// Split a table row on unescaped pipes (marked's splitCells).
// Returns array of cell strings, or null if the row has no pipe structure
// issues. `expected` = pad/truncate to this many cells (0 = no padding).
function splitTableRow(row, expected) {
  // mark escaped pipes: replace unescaped | with " |", keep escaped as |
  let t = "";
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === "|") {
      let bs = 0;
      for (let k = i - 1; k >= 0 && row[k] === "\\"; k--) bs++;
      t += bs % 2 === 1 ? "|" : " |";
    } else {
      t += c;
    }
  }
  let cells = t.split(" |");
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  if (expected > 0) {
    if (cells.length > expected) cells = cells.slice(0, expected);
    while (cells.length < expected) cells.push("");
  }
  return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
}

/* ---------------- block list parsing ---------------- */

// Can the line at lines[i] start a block that interrupts a paragraph?
// (Used by the paragraph collector and lazy-continuation checks.)
function interruptsParagraph(lines, i, inItem = false) {
  const line = lines[i];
  if (isBlankLine(line)) return true; // blank ends the paragraph
  const { indent, idx } = lineIndent(line);
  if (indent >= 4) return false; // indented code can't interrupt
  if (matchAtx(line, idx)) return true;
  if (matchFence(line, idx)) return true;
  const html = matchHtmlBlock(line, idx);
  if (html && html.type !== 7) return true;
  if (matchBlockquote(line, idx)) return true;
  if (matchHr(line, idx)) return true;
  const lm = matchListMarker(line, idx);
  if (lm) {
    // a list interrupts only if its first item is non-empty, and for
    // ordered lists only if it starts at 1 — EXCEPT inside a list item,
    // where marked lets any ordered list interrupt a paragraph
    // (verified: '* foo\n  0. bar' nests the list, but 'foo\n0. bar'
    // at top level stays a paragraph)
    const after = line.slice(idx + lm.markerLen);
    const hasContent = after.trim() !== "";
    if (!hasContent) return false;
    if (lm.ordered && lm.start !== 1 && !inItem) return false;
    return true;
  }
  return false;
}

// Collect paragraph lines starting at lines[i]. Returns { text, next } where
// next is the index after the last paragraph line. The lines keep their
// leading spaces (marked preserves them).
// eofNl: whether the last line of the range is followed by a newline.
function collectParagraphLines(lines, i, end, eofNl, inItem = false) {
  const out = [lines[i]];
  let j = i + 1;
  while (j < end) {
    if (isBlankLine(lines[j])) {
      // a non-empty whitespace-only LAST line with no trailing newline is
      // a paragraph continuation (marked's paragraph regex excludes
      // [ \t]+\n only when a newline follows it); a truly empty line is not
      if (j === end - 1 && !eofNl && lines[j].length > 0) { out.push(lines[j]); j++; }
      break;
    }
    if (interruptsParagraph(lines, j, inItem)) break;
    out.push(lines[j]);
    j++;
  }
  return { text: out.join("\n"), next: j, lines: out };
}

// Parse a table starting at lines[i] (header) with delimiter at lines[i+1].
// Returns { block, next } or null.
function parseTable(lines, i, refs) {
  if (i + 1 >= lines.length) return null;
  const hIndent = lineIndent(lines[i]);
  if (hIndent.indent >= 4) return null;
  if (lines[i].trim() === "") return null;
  const dIndent = lineIndent(lines[i + 1]);
  if (dIndent.indent >= 4) return null;
  const align = matchTableDelimiter(lines[i + 1], dIndent.idx);
  if (!align) return null;
  // the header must have exactly as many cells as the delimiter row
  const headerCells = splitTableRow(lines[i].slice(hIndent.idx), 0);
  if (headerCells.length !== align.length) return null;
  const header = splitTableRow(lines[i].slice(hIndent.idx), align.length);
  const rows = [];
  let j = i + 2;
  while (j < lines.length) {
    const line = lines[j];
    // a line of 0-3 spaces + a single tab is an (empty) table row in
    // marked: its table regex only excludes space-only blank lines and
    // indented code, and a lone trailing tab is neither
    if (/^ {0,3}\t$/.test(line)) {
      rows.push(splitTableRow("", align.length));
      j++;
      continue;
    }
    if (isBlankLine(line)) break;
    const { indent, idx } = lineIndent(line);
    if (indent >= 4) break;
    if (matchHr(line, idx) || matchAtx(line, idx) || matchBlockquote(line, idx) ||
        matchFence(line, idx) || matchHtmlBlock(line, idx) || matchListMarker(line, idx)) break;
    rows.push(splitTableRow(line.slice(idx), align.length));
    j++;
  }
  return { block: { kind: "table", header, align, rows }, next: j };
}

// Parse an HTML block starting at lines[i]. Returns { block, next } or null.
function parseHtml(lines, i) {
  const { indent, idx } = lineIndent(lines[i]);
  if (indent >= 4) return null;
  const h = matchHtmlBlock(lines[i], idx);
  if (!h) return null;
  if (h.type === 7) {
    // type 7 consumes lines until a blank line, like type 6
    // (it just cannot interrupt a paragraph)
    let j = i + 1;
    while (j < lines.length && !isBlankLine(lines[j])) j++;
    return { block: { kind: "html", text: lines.slice(i, j).join("\n") }, next: j };
  }
  if (h.type === 6) {
    // ends at a blank line
    let j = i + 1;
    while (j < lines.length && !isBlankLine(lines[j])) j++;
    return { block: { kind: "html", text: lines.slice(i, j).join("\n") }, next: j };
  }
  // types 1-5: end at the line containing the closing marker
  const closer = h.type === 1 ? new RegExp("</" + h.tag + "(\\s|>|$)", "i")
    : h.type === 2 ? /-->/ : h.type === 3 ? /\?>/ : h.type === 4 ? />/ : /\]\]>/;
  let j = i;
  if (!closer.test(lines[i].slice(idx + (h.type === 1 ? h.tag.length + 1 : 0)))) {
    j = i + 1;
    while (j < lines.length && !closer.test(lines[j])) j++;
    if (j < lines.length) j++; // include the closing line
  } else {
    j = i + 1;
  }
  // for type 1, the closing tag must be on a line by itself scan: re-check
  // the first line properly (the slice above may have missed a same-line close)
  if (h.type === 1 && j === i + 1 && !closer.test(lines[i])) {
    j = i + 1;
    while (j < lines.length && !closer.test(lines[j])) j++;
    if (j < lines.length) j++;
  }
  let text = lines.slice(i, j).join("\n");
  // types 1-5 keep the newline after the closing line (marked's regexes
  // consume it, and its `ge` keeps a single trailing newline) — except
  // when the next line is exactly empty: then the regex also swallows
  // that line's newline and `ge` strips both. A tab-only or spaces-only
  // next line is NOT empty, so the newline is kept.
  if (j < lines.length && lines[j] !== "") text += "\n";
  return { block: { kind: "html", text }, next: j };
}

// Parse a fenced code block starting at lines[i]. Returns { block, next }.
function parseFence(lines, i) {
  const { indent, idx } = lineIndent(lines[i]);
  const f = matchFence(lines[i], idx);
  const lang = (unescapeStr(f.info).split(/\s+/)[0] || "");
  const content = [];
  let j = i + 1;
  let closed = false;
  while (j < lines.length) {
    const { indent: ind2, idx: idx2 } = lineIndent(lines[j]);
    if (ind2 < 4) {
      const c = lines[j][idx2];
      if (c === f.char) {
        let n = 0;
        while (lines[j][idx2 + n] === c) n++;
        if (n >= f.len && lines[j].slice(idx2 + n).trim() === "") {
          closed = true;
          j++;
          break;
        }
      }
    }
    // strip up to the opening fence's indent — but ONLY for backtick
    // fences: marked never strips content indent for tilde fences
    // (verified: `  ~~~` + `  aaa` keeps both spaces).
    content.push(f.char === "~" ? lines[j] : stripIndent(lines[j], indent));
    j++;
  }
  let text = content.length > 0 ? content.join("\n") : "";
  return { block: { kind: "code", text, lang }, next: j };
}

// Parse an indented code block starting at lines[i]. Returns { block, next }.
function parseIndentedCode(lines, i) {
  const content = [];
  let j = i;
  let trailingBlanks = 0;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // a whitespace-only line with indent >= 4 is a CODE line
      // (strip 4, keep the rest), not a blank line
      const ind = lineIndent(line);
      if (ind.indent >= 4) {
        content.push(stripIndent(line, 4));
        trailingBlanks = 0;
        j++;
        continue;
      }
      // look ahead: if the next non-blank line is indented code, keep going
      let k = j + 1;
      while (k < lines.length && isBlankLine(lines[k])) k++;
      if (k < lines.length && lineIndent(lines[k]).indent >= 4) {
        // blank lines inside the code block
        for (let b = j; b < k; b++) content.push("");
        trailingBlanks = 0;
        j = k;
        continue;
      }
      break;
    }
    if (lineIndent(line).indent < 4) break;
    content.push(stripIndent(line, 4));
    trailingBlanks = 0;
    j++;
  }
  // strip trailing blank lines (whitespace-only lines count as blank)
  while (content.length > 0 && content[content.length - 1].trim() === "") content.pop();
  const text = content.length > 0 ? content.join("\n") + "\n" : "";
  return { block: { kind: "code", text, lang: "" }, next: j };
}

// The main block-list parser. Parses lines[start..end) into blocks.
// eofNl: true only for the top-level parse when the input ends with "\n"
// (an html block running to EOF then keeps a trailing newline).
function parseBlockList(lines, refs, start = 0, end = lines.length, eofNl = false, inItem = false, itemText = false) {
  const blocks = [];
  let i = start;
  // push a block, recording its line range [_s, _e) for looseness checks
  const pushB = (block, nextI) => { block._s = i; block._e = nextI; blocks.push(block); i = nextI; };
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const { indent, idx } = lineIndent(line);
    // link reference definitions (only at block starts, indent < 4)
    if (indent < 4 && line[idx] === "[") {
      const def = parseRefDef(lines, i, line.slice(idx));
      if (def) {
        if (!Object.prototype.hasOwnProperty.call(refs, def.label)) {
          refs[def.label] = { dest: def.dest, title: def.title };
        }
        i = def.nextLine;
        continue;
      }
    }
    if (indent < 4) {
      // fenced code
      const f = matchFence(line, idx);
      if (f) {
        const r = parseFence(lines, i);
        pushB(r.block, r.next);
        continue;
      }
      // ATX heading
      const atx = matchAtx(line, idx);
      if (atx) {
        pushB({ kind: "heading", depth: atx.depth, text: atx.text }, i + 1);
        continue;
      }
      // HTML block
      const html = matchHtmlBlock(line, idx);
      if (html) {
        const r = parseHtml(lines, i);
        if (r.next === end && eofNl) r.block.text += "\n";
        pushB(r.block, r.next);
        continue;
      }
      // blockquote
      if (matchBlockquote(line, idx)) {
        const r = parseBlockquote(lines, i, end, refs, inItem);
        pushB(r.block, r.next);
        continue;
      }
      // thematic break (before list: marked tries hr first)
      if (matchHr(line, idx)) {
        pushB({ kind: "hr" }, i + 1);
        continue;
      }
      // list
      const lm = matchListMarker(line, idx);
      if (lm) {
        const r = parseList(lines, i, end, refs);
        pushB(r.block, r.next);
        continue;
      }
      // table (header + delimiter row)
      const t = parseTable(lines, i, refs);
      if (t) {
        pushB(t.block, t.next);
        continue;
      }
    } else {
      // indented code
      const r = parseIndentedCode(lines, i);
      pushB(r.block, r.next);
      continue;
    }
    // paragraph (with setext check)
    const para = collectParagraphLines(lines, i, end, eofNl, inItem);
    let pLines = para.lines;
    let next = para.next;
    // setext: the FIRST collected line (after line 0) that is an underline
    // ends the paragraph as a heading (marked's lheading matches at the
    // paragraph start, so a mid-paragraph underline cuts the paragraph).
    let setext = null;
    for (let k = 1; k < pLines.length; k++) {
      const li = lineIndent(pLines[k]);
      if (li.indent < 4) {
        const s = matchSetext(pLines[k], li.idx);
        if (s) {
          setext = s;
          next = i + k + 1;
          pLines = pLines.slice(0, k);
          break;
        }
      }
    }
    if (!setext && next < end && !isBlankLine(lines[next])) {
      const nInd = lineIndent(lines[next]);
      if (nInd.indent < 4) {
        const s = matchSetext(lines[next], nInd.idx);
        if (s) {
          // the underline must not be a list item or hr that starts a block;
          // a '-' underline is a setext heading, not a list/hr, here
          setext = s;
          next++;
        }
      }
    }
    if (setext) {
      pushB({ kind: "heading", depth: setext, text: pLines.join("\n").trim() }, next);
    } else {
      let text = pLines.join("\n");
      if (itemText) {
        // Inside a list item marked lexes with state.top=false, so a
        // continuation line indented >= 4 is tokenized as indented code
        // and merged into the text with the code indent stripped.
        let stripped = null;
        for (let k = 1; k < pLines.length; k++) {
          const l = pLines[k];
          if ((l[0] === " " || l[0] === "\t") && !isBlankLine(l) && lineIndent(l).indent >= 4) {
            if (!stripped) stripped = pLines.slice();
            stripped[k] = stripCodeIndent(l);
          }
        }
        if (stripped) text = stripped.join("\n");
      }
      pushB({ kind: "para", text }, next);
    }
  }
  return blocks;
}

/* ---------------- blockquote & list ---------------- */

// Find the deepest last paragraph in a block list (descending into trailing
// quotes and list items). Used for lazy continuation.
function deepestPara(blocks) {
  if (blocks.length === 0) return null;
  const last = blocks[blocks.length - 1];
  if (last.kind === "para") return last;
  if (last.kind === "quote") return deepestPara(last.children);
  if (last.kind === "list" && last.items.length > 0) {
    return deepestPara(last.items[last.items.length - 1].children);
  }
  return null;
}

// Strip a blockquote marker: '>' + one optional space (tab-aware).
// Expands all whitespace after '>' from column indent+1, then consumes
// exactly one space.
function stripQuoteMarker(line, indent, idx) {
  const rest = line.slice(idx + 1);
  let col = indent + 1;
  let ws = "", wi = 0;
  while (wi < rest.length && (rest[wi] === " " || rest[wi] === "\t")) {
    if (rest[wi] === "\t") { const w = 4 - (col % 4); ws += " ".repeat(w); col += w; }
    else { ws += " "; col++; }
    wi++;
  }
  return (ws.length > 0 ? ws.slice(1) : "") + rest.slice(wi);
}

function parseBlockquote(lines, i, end, refs, inItem = false) {
  const children = [];
  let j = i;
  let prevClosed = false;
  for (;;) {
    // collect a chunk of '>' lines (a truly blank line ends the quote)
    const inner = [];
    while (j < end) {
      const line = lines[j];
      if (isBlankLine(line)) break;
      const { indent, idx } = lineIndent(line);
      if (indent < 4 && line[idx] === ">") {
        inner.push(stripQuoteMarker(line, indent, idx));
        j++;
        continue;
      }
      break;
    }
    if (inner.length === 0) break;
    // a trailing blank inner line closes the paragraph (no lazy continuation)
    const paraClosed = isBlankLine(inner[inner.length - 1]);
    const chunkStartsBlank = isBlankLine(inner[0]);
    const chunk = parseBlockList(inner, refs, 0, inner.length, false, inItem);
    // merge the chunk's first block into the deepest open block of the
    // same kind (only if no blank line separates them): a leading
    // paragraph joins the deepest open paragraph, and a leading nested
    // quote continues the previous quote child (lazy lines between two
    // chunks of one inner quote must not split it).
    if (chunk.length > 0 && !prevClosed && !chunkStartsBlank) {
      if (chunk[0].kind === "para") {
        const dp = deepestPara(children);
        if (dp) {
          dp.text += "\n" + chunk[0].text;
          chunk.shift();
        }
      } else if (chunk[0].kind === "quote") {
        const last = children[children.length - 1];
        if (last && last.kind === "quote") {
          const first = chunk[0].children;
          if (first.length > 0 && first[0].kind === "para") {
            const dp = deepestPara(last.children);
            if (dp) {
              dp.text += "\n" + first[0].text;
              first.shift();
            }
          }
          last.children.push(...first);
          chunk.shift();
        }
      }
    }
    children.push(...chunk);
    prevClosed = paraClosed;
    // lazy continuation lines extend the deepest paragraph
    while (j < end && !paraClosed) {
      const dp = deepestPara(children);
      if (!dp) break;
      const line = lines[j];
      if (isBlankLine(line)) break;
      const { indent, idx } = lineIndent(line);
      if (indent < 4 && line[idx] === ">") break;
      // a lazy hr ends the quote (it is not lazy text)
      if (indent < 4 && matchHr(line, idx)) break;
      const s = indent < 4 ? matchSetext(line, idx) : null;
      if (s) {
        // lazy setext underline: paragraph text, indented 4 so it cannot
        // become a heading in the inner parse
        dp.text += "\n    " + line.slice(idx);
        j++;
        continue;
      }
      if (interruptsParagraph(lines, j, inItem)) break;
      if (indent >= 4) dp.text += "\n" + stripIndent(line, 4);
      else dp.text += "\n" + line;
      j++;
    }
    // if the next line starts a '>' group, it joins the same quote
    // (connected by the lazy lines above)
    if (j < end && !isBlankLine(lines[j])) {
      const { indent, idx } = lineIndent(lines[j]);
      if (indent < 4 && lines[j][idx] === ">") continue;
    }
    break;
  }
  return { block: { kind: "quote", children }, next: j };
}

function parseListItem(lines, i, end, refs) {
  const { indent, idx } = lineIndent(lines[i]);
  const m = matchListMarker(lines[i], idx);
  const afterMarker = lines[i].slice(idx + m.markerLen);
  let spaces = 0;
  let sp = 0;
  let col = indent + m.markerLen;
  while (sp < afterMarker.length && (afterMarker[sp] === " " || afterMarker[sp] === "\t")) {
    if (afterMarker[sp] === " ") { spaces++; col++; sp++; }
    else { const w = 4 - (col % 4); spaces += w; col += w; sp++; }
  }
  const content = afterMarker.slice(sp);
  let contentIndent;
  let firstLine;
  if (content === "") {
    contentIndent = indent + m.markerLen + 1;
    firstLine = "";
  } else if (spaces > 4) {
    contentIndent = indent + m.markerLen + 1;
    firstLine = " ".repeat(spaces - 1) + content;
  } else {
    contentIndent = indent + m.markerLen + spaces;
    firstLine = content;
  }
  const children = [];
  const allLines = []; // all item lines in order (for looseness ranges)
  let loose = false;
  let j = i + 1;
  let first = true;
  let prevClosed = false;
  for (;;) {
    // collect a chunk of lines belonging to the item
    const chunkLines = first ? [firstLine] : [];
    first = false;
    const chunkStart = allLines.length;
    let chunkHasContent = chunkLines.some((l) => !isBlankLine(l));
    while (j < end) {
      const line = lines[j];
      if (isBlankLine(line)) {
        let k = j + 1;
        while (k < end && isBlankLine(lines[k])) k++;
        if (k >= end) break;
        const { indent: ind2, idx: idx2 } = lineIndent(lines[k]);
        // a blank line belongs to the item only if followed by indented
        // content (a '>' line at a lower indent is a new top-level block)
        if (ind2 < contentIndent) break;
        // a blank line only belongs to the item if the item already has
        // content (an empty item followed by a blank line ends the item)
        if (!chunkHasContent && children.length === 0) break;
        for (let b = j; b < k; b++) chunkLines.push("");
        j = k;
        continue;
      }
      const { indent: ind2, idx: idx2 } = lineIndent(line);
      if (ind2 >= contentIndent) {
        chunkLines.push(stripIndentExpand(line, contentIndent));
        chunkHasContent = true;
        j++;
        continue;
      }
      // Lazy continuation line (indent below the content indent): it still
      // belongs to the item unless it starts a block at a low indent, or the
      // previous line was blank, indented code, or a fence/heading/html/hr
      // start (marked's list-item lazy rules). Lazy lines are what let a
      // fenced code block inside an item keep consuming its under-indented
      // content lines instead of closing early and swallowing later blocks.
      if (!chunkHasContent && children.length === 0) break;
      const maxBreakIndent = contentIndent - 1 < 3 ? contentIndent - 1 : 3;
      if (ind2 <= maxBreakIndent) {
        if (matchFence(line, idx2) || matchAtx(line, idx2) || matchHtmlBlock(line, idx2) ||
            matchBlockquote(line, idx2) || matchListMarker(line, idx2) || matchHr(line, idx2)) break;
      }
      const prevLine = chunkLines[chunkLines.length - 1];
      if (prevLine === undefined || isBlankLine(prevLine)) break;
      // previous line indented-code-like (tabs count as 4, like marked)
      const prevExpanded = prevLine.indexOf("\t") >= 0 ? prevLine.replace(/\t/g, "    ") : prevLine;
      let p = 0;
      while (p < prevExpanded.length && prevExpanded[p] === " ") p++;
      if (p >= 4) break;
      if (p <= maxBreakIndent) {
        if (matchFence(prevExpanded, p) || matchAtx(prevExpanded, p) ||
            matchHtmlBlock(prevExpanded, p) || matchHr(prevExpanded, p)) break;
      }
      // a setext underline as a lazy line is indented so it stays paragraph
      // text instead of forming a heading (marked's lheading check)
      const prevIsQuoteOrList = matchBlockquote(prevExpanded, p) || matchListMarker(prevExpanded, p);
      if (ind2 < 4 && !prevIsQuoteOrList && matchSetext(line, idx2)) {
        chunkLines.push("    " + line.slice(idx2));
      } else {
        chunkLines.push(line);
      }
      chunkHasContent = true;
      j++;
    }
    for (const l of chunkLines) allLines.push(l);
    if (chunkLines.length > 0) {
      const paraClosed = isBlankLine(chunkLines[chunkLines.length - 1]);
      const chunkStartsBlank = isBlankLine(chunkLines[0]);
      const chunk = parseBlockList(chunkLines, refs, 0, chunkLines.length, false, true, true);
      // offset block ranges into allLines coordinates
      for (const b of chunk) { b._s += chunkStart; b._e += chunkStart; }
      // merge the chunk's first paragraph into the deepest open paragraph
      if (chunk.length > 0 && chunk[0].kind === "para" && !prevClosed && !chunkStartsBlank) {
        const dp = deepestPara(children);
        if (dp) {
          dp.text += "\n" + chunk[0].text;
          dp._e = chunk[0]._e;
          chunk.shift();
        }
      }
      // looseness: a blank line between two adjacent direct children
      for (let c = 0; c < chunk.length; c++) {
        const prev = c === 0 ? children[children.length - 1] : chunk[c - 1];
        if (prev) {
          for (let l = prev._e; l < chunk[c]._s; l++) {
            if (isBlankLine(allLines[l])) { loose = true; break; }
          }
        }
      }
      children.push(...chunk);
      prevClosed = paraClosed;
    }
    // lazy continuation lines extend the deepest paragraph
    const lazyParaClosed = chunkLines.length > 0 && isBlankLine(chunkLines[chunkLines.length - 1]);
    while (j < end && !lazyParaClosed) {
      const dp = deepestPara(children);
      if (!dp) break;
      const line = lines[j];
      if (isBlankLine(line)) break;
      const { indent: ind2, idx: idx2 } = lineIndent(line);
      if (ind2 >= contentIndent) break;
      if (ind2 < 4 && matchListMarker(line, idx2)) break;
      if (ind2 < 4 && line[idx2] === ">") break;
      // a lazy hr ends the item (it is not lazy text)
      if (ind2 < 4 && matchHr(line, idx2)) break;
      const s = ind2 < 4 ? matchSetext(line, idx2) : null;
      if (s) { dp.text += "\n    " + line.slice(idx2); j++; continue; }
      if (interruptsParagraph(lines, j, true)) break;
      if (ind2 >= 4) dp.text += "\n" + stripIndent(line, 4);
      else dp.text += "\n" + line;
      j++;
    }
    // if the next line is blank followed by indented content, or is
    // indented content, it belongs to the item: continue the loop
    if (j < end && (children.length > 0 || chunkHasContent)) {
      let k = j;
      while (k < end && isBlankLine(lines[k])) k++;
      if (k < end) {
        const { indent: ind2 } = lineIndent(lines[k]);
        if (ind2 >= contentIndent) continue;
      }
    }
    break;
  }
  // looseness: a blank line followed by a link reference definition also
  // makes the item loose (the def is consumed, so no block marks it)
  if (!loose) {
    for (let b = 0; b < allLines.length; b++) {
      if (!isBlankLine(allLines[b])) continue;
      // non-blank content before the blank?
      let hasBefore = false;
      for (let c = 0; c < b; c++) if (!isBlankLine(allLines[c])) { hasBefore = true; break; }
      if (!hasBefore) continue;
      // next non-blank line: a def at the item's top level?
      let k = b + 1;
      while (k < allLines.length && isBlankLine(allLines[k])) k++;
      if (k < allLines.length) {
        const { indent: di, idx: dx } = lineIndent(allLines[k]);
        if (di < 4 && allLines[k][dx] === "[" && parseRefDef(allLines, k, allLines[k].slice(dx))) {
          loose = true;
          break;
        }
      }
    }
  }
  // task list checkbox at the start of the item's first paragraph
  let task = null;
  const firstContent = firstLine;
  if (/^\[[ xX]\][ \t]+\S/.test(firstContent) && children.length > 0 && children[0].kind === "para") {
    task = firstContent[1] === " " ? " " : "x";
    const stripped = firstContent.replace(/^\[[ xX]\][ \t]+/, "");
    children[0].text = stripped + children[0].text.slice(firstContent.length);
  }
  return { item: { children, task }, next: j, loose };
}

function parseList(lines, i, end, refs) {
  const { indent, idx } = lineIndent(lines[i]);
  const first = matchListMarker(lines[i], idx);
  const ordered = first.ordered;
  const delim = first.delim;
  const bullet = first.bullet;
  const start = first.start;
  const items = [];
  let loose = false;
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) {
      let k = j + 1;
      while (k < end && isBlankLine(lines[k])) k++;
      if (k < end) {
        const { indent: ind2, idx: idx2 } = lineIndent(lines[k]);
        const m2 = ind2 < 4 ? matchListMarker(lines[k], idx2) : null;
        if (m2 && m2.ordered === ordered && (ordered ? m2.delim === delim : m2.bullet === bullet)) {
          loose = true;
          j = k;
          continue;
        }
      }
      break;
    }
    const { indent: ind2, idx: idx2 } = lineIndent(line);
    // a line that is an hr is not a list item (the list ends)
    if (ind2 < 4 && matchHr(line, idx2)) break;
    const m2 = ind2 < 4 ? matchListMarker(line, idx2) : null;
    if (!m2 || m2.ordered !== ordered || (ordered ? m2.delim !== delim : m2.bullet !== bullet)) break;
    const res = parseListItem(lines, j, end, refs);
    items.push(res.item);
    if (res.loose) loose = true;
    j = res.next;
  }
  return { block: { kind: "list", ordered, start, loose, items }, next: j };
}

/* ---------------- rendering ---------------- */

function renderBlocks(blocks, refs) {
  let out = "";
  for (const b of blocks) {
    switch (b.kind) {
      case "para":
        out += "<p>" + renderInline(inlineParse(b.text, refs)) + "</p>\n";
        break;
      case "heading":
        out += "<h" + b.depth + ">" + renderInline(inlineParse(b.text, refs)) + "</h" + b.depth + ">\n";
        break;
      case "code": {
        const text = b.text ? b.text.replace(/\n$/, "") + "\n" : "";
        if (b.lang) {
          out += '<pre><code class="language-' + escNoEnc(b.lang) + '">' + escAll(text) + "</code></pre>\n";
        } else {
          out += "<pre><code>" + escAll(text) + "</code></pre>\n";
        }
        break;
      }
      case "hr":
        out += "<hr>\n";
        break;
      case "quote":
        out += "<blockquote>\n" + renderBlocks(b.children, refs) + "</blockquote>\n";
        break;
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const startAttr = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : "";
        out += "<" + tag + startAttr + ">\n";
        for (const item of b.items) {
          out += "<li>";
          out += renderListItem(item, b.loose, refs);
          out += "</li>\n";
        }
        out += "</" + tag + ">\n";
        break;
      }
      case "table": {
        out += "<table>\n<thead>\n<tr>\n";
        for (let c = 0; c < b.header.length; c++) {
          const a = b.align[c];
          out += a ? '<th align="' + a + '">' : "<th>";
          out += renderInline(inlineParse(b.header[c], refs)) + "</th>\n";
        }
        out += "</tr>\n</thead>\n";
        if (b.rows.length > 0) {
          out += "<tbody>";
          for (const row of b.rows) {
            out += "<tr>\n";
            for (let c = 0; c < row.length; c++) {
              const a = b.align[c];
              out += a ? '<td align="' + a + '">' : "<td>";
              out += renderInline(inlineParse(row[c], refs)) + "</td>\n";
            }
            out += "</tr>\n";
          }
          out += "</tbody>";
        }
        out += "</table>\n";
        break;
      }
      case "html":
        out += b.text;
        break;
    }
  }
  return out;
}

function renderListItem(item, loose, refs) {
  let out = "";
  const kids = item.children;
  for (let ci = 0; ci < kids.length; ci++) {
    const c = kids[ci];
    if (c.kind === "para") {
      const inner = renderInline(inlineParse(c.text, refs));
      if (loose) {
        out += "<p>" + (ci === 0 && item.task !== null ? checkboxHtml(item.task) + " " : "") + inner + "</p>\n";
      } else {
        out += (ci === 0 && item.task !== null ? checkboxHtml(item.task) + " " : "") + inner;
      }
    } else {
      out += renderBlocks([c], refs);
    }
  }
  // a task item whose first block is not a paragraph: checkbox goes first
  if (item.task !== null && (kids.length === 0 || kids[0].kind !== "para")) {
    out = checkboxHtml(item.task) + " " + out;
  }
  return out;
}

function checkboxHtml(task) {
  return task === "x"
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
}

/* ---------------- entry point ---------------- */

export function parse(markdown) {
  docInLink = false;
  const src = String(markdown).replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "" && src.endsWith("\n")) {
    lines.pop();
  }
  const refs = Object.create(null);
  const blocks = parseBlockList(lines, refs, 0, lines.length, src.endsWith("\n"));
  return renderBlocks(blocks, refs);
}
