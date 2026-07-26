import { describe, it, expect } from 'vitest';
import { highlightKQL } from '../highlight.js';

/**
 * These import the real module. The previous suite re-implemented the functions it claimed
 * to test, so it could not detect a regression in the shipped code — and two of its copies
 * had already drifted from the originals.
 */

/** Strip the generated markup and unescape, to recover the text the user actually typed. */
const strip = (html) => html
  .replace(/<span style="[^"]*">/g, '')
  .replace(/<\/span>/g, '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const hasNestedSpan = (html) => /<span[^>]*>(?:(?!<\/span>).)*<span/s.test(html);

/**
 * Independent reference lexer: leftmost-wins scan for // comments and quoted strings.
 * The implementation must agree with this for every input.
 */
function lex(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '/' && s[i + 1] === '/') {
      let j = s.indexOf('\n', i);
      if (j === -1) j = s.length;
      out.push(['comment', s.slice(i, j)]);
      i = j;
      continue;
    }
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i];
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\') {
          if (j + 1 >= s.length || s[j + 1] === '\n') break;
          j += 2;
          continue;
        }
        if (s[j] === quote) { closed = true; j++; break; }
        j++;
      }
      if (closed) { out.push(['string', s.slice(i, j)]); i = j; continue; }
      i++;
      continue;
    }
    i++;
  }
  return out;
}

const COMMENT = '#5c6370';
const STRING = '#98c379';

/** Extract the comment/string tokens the implementation actually produced. */
function tokensOf(html) {
  const out = [];
  const re = new RegExp(`<span style="color:(${COMMENT}|${STRING})">((?:(?!</span>).)*)</span>`, 'gs');
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push([m[1] === COMMENT ? 'comment' : 'string', strip(m[2])]);
  }
  return out;
}

describe('highlightKQL', () => {
  it('returns an empty string for non-string input', () => {
    expect(highlightKQL(null)).toBe('');
    expect(highlightKQL(undefined)).toBe('');
    expect(highlightKQL(42)).toBe('');
  });

  it('escapes HTML before inserting any markup', () => {
    const out = highlightKQL('SigninLogs // <script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  // Regression: $&, $` and $' are special patterns for a STRING replacement argument.
  // Placeholders hold user text, so a body containing $' re-inserted the rest of the
  // output on every restore iteration. 116 bytes expanded to ~41 MB and hung the tab
  // on every page load, because the payload fits on one line and so renders collapsed.
  describe('$-expansion (KQS-001)', () => {
    it('keeps output linear for an adversarial $\' payload', () => {
      const payload = `X | where Y in (${Array.from({ length: 20 }, () => `"$'"`).join(',')})`;
      const out = highlightKQL(payload);
      expect(out.length).toBeLessThan(payload.length * 40);
    });

    it('does not blow up as the payload grows', () => {
      const build = (n) => `X | where Y in (${Array.from({ length: n }, () => `"$'"`).join(',')})`;
      const small = highlightKQL(build(8)).length;
      const large = highlightKQL(build(24)).length;
      // Linear growth, not exponential: tripling the tokens must not cube the output.
      expect(large).toBeLessThan(small * 10);
    });

    it.each(['$&', '$`', "$'", '$$'])('renders %s literally', (seq) => {
      expect(strip(highlightKQL(`SigninLogs // ${seq} test`))).toBe(`SigninLogs // ${seq} test`);
    });
  });

  // Regression: the placeholder prefix was a fixed literal, so a query containing
  // __PH0__ was substituted by the restore loop — relocating a comment into a string
  // literal and leaking the raw token as visible text.
  describe('placeholder spoofing', () => {
    it('preserves a literal __PH0__ and leaves the comment in place', () => {
      const input = '| where X == "__PH0__"\n// SECRET-COMMENT';
      const out = highlightKQL(input);
      expect(strip(out)).toBe(input);
      expect(out).toMatch(/<span style="color:#5c6370">\/\/ SECRET-COMMENT<\/span>/);
    });

    it.each(['__PH', '__PH0__', '__PHX0__', '__PH0__ __PHX0__ __PHXX0__'])(
      'round-trips %s unchanged', (payload) => {
        const input = `// c\n| where X == "${payload}"`;
        expect(strip(highlightKQL(input))).toBe(input);
      });
  });

  // Regression: comments were matched in a pass before strings, so // inside a URL
  // literal opened a comment that swallowed the rest of the line AND the line after it,
  // rendering a live predicate as though it were commented out.
  describe('comments vs strings (KQS-039)', () => {
    it('treats // inside a string as string content', () => {
      const out = highlightKQL('| where U has "https://portal.azure.com/x"\n| where A == "B"');
      expect(out).not.toContain(COMMENT);
      expect(out).toContain(`<span style="color:${STRING}">"https://portal.azure.com/x"</span>`);
      expect(out).toContain('A');
    });

    it('treats a quote inside a comment as comment content', () => {
      const out = highlightKQL("// don't treat this as a string\nSigninLogs | take 5");
      expect(out).toContain(COMMENT);
      expect(out).not.toContain(STRING);
      expect(out).toContain('<span style="color:#e5c07b">SigninLogs</span>');
    });

    it('agrees with an independent reference lexer across combinations', () => {
      const frag = ['// c ', '"a//b"', "'x//y'", '| where X == ', 'SigninLogs', '"ok"',
        "// don't ", '\n', 'take 5', '"https://p.com"', '@"re\\.x"', ' and ', '// note "q" '];
      for (let i = 0; i < 400; i++) {
        let s = '';
        const n = 1 + (i % 6);
        for (let j = 0; j < n; j++) s += frag[(i * 7 + j * 3) % frag.length];
        if (!s.trim()) continue;
        expect(tokensOf(highlightKQL(s)), `input: ${JSON.stringify(s)}`).toEqual(lex(s));
      }
    });
  });

  it('never nests spans and always round-trips the input text', () => {
    const frag = ['// c ', '"a//b"', '| where X == ', 'SigninLogs', "'q'", '\n', '5m', '$\'', '__PH0__'];
    for (let i = 0; i < 400; i++) {
      let s = '';
      const n = 1 + (i % 5);
      for (let j = 0; j < n; j++) s += frag[(i * 5 + j * 2) % frag.length];
      if (!s.trim()) continue;
      const out = highlightKQL(s);
      expect(hasNestedSpan(out), `nested span for ${JSON.stringify(s)}`).toBe(false);
      expect(strip(out), `round-trip for ${JSON.stringify(s)}`).toBe(s);
    }
  });

  it('highlights the basics', () => {
    const out = highlightKQL('SigninLogs\n| where TimeGenerated > ago(1d)');
    expect(out).toContain('<span style="color:#e5c07b">SigninLogs</span>');
    expect(out).toContain('<span style="color:#c678dd">where</span>');
    expect(out).toContain('<span style="color:#61afef">ago</span>');
  });
});
