import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, readdirSync } from 'fs';
import logSymbols from 'log-symbols';
import { initContext } from '../src/commands/init.js';

/**
 * Every level in src/utils/log.ts already prints its own glyph: log-symbols for
 * info/success/warn/error, an emoji for the custom levels. A message carrying a
 * glyph of its own therefore renders as two (`✔ ✓ Created .context/`).
 *
 * Unicode category alone is not enough. `\p{So}` covers ✔ ✓ ✅ ⚠ ✖ and the
 * emoji, but NOT `ℹ` — U+2139 INFORMATION SOURCE is category Ll, so a
 * `\p{So}`-only check silently misses exactly the doubling this issue reports
 * (`ℹ ℹ️  Run \`prelude export\``). So the glyph set is the union of `\p{So}`
 * and the symbols log-symbols actually emits.
 *
 * `\p{So}` also matches the custom-level emoji (🎯 📤 🧠 👀 🔍 ✍️) but not list
 * bullets (•, category Po), which are meant to stay.
 */
/** Same escape-sequence handling as src/core/diff.ts: a string, not a regex literal,
 *  so eslint's no-control-regex does not fire. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, 'g');

const LOG_SYMBOLS = [logSymbols.success, logSymbols.error, logSymbols.info, logSymbols.warning]
  .map(s => s.replace(ANSI_RE, ''));

const isGlyph = (c: string) => /\p{So}/u.test(c) || LOG_SYMBOLS.includes(c);
const stripAnsi = (line: string) => line.replace(ANSI_RE, '');
/** Leading escape sequences (\n) and indentation never carry a glyph. */
const messageBody = (literal: string) => literal.replace(/^(?:\\[nrt]|\\u[0-9a-fA-F]{4}|\s)+/, '');
/**
 * A doubled line is the logger's glyph followed by the message's own glyph.
 * Both are stripped of ANSI and whitespace first, so `✔ ✔ text` is caught
 * while a correct `✔ text` is not.
 */
const isDoubled = (line: string) => {
  const chars = [...stripAnsi(line).trim()];
  if (!chars.length || !isGlyph(chars[0])) return false;
  let i = 1;
  if (chars[i] === '\uFE0F') i++;          // emoji variation selector
  while (chars[i] === ' ' || chars[i] === '\t') i++;
  return i < chars.length && isGlyph(chars[i]);
};

describe('prelude init status output', () => {
  let lines: string[] = [];

  beforeAll(async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'prelude-log-symbols-'));
    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'log-fixture', version: '1.0.0' }));
    await mkdir(join(rootDir, 'src', 'core'), { recursive: true });
    await writeFile(join(rootDir, 'src', 'index.ts'), "import { run } from './core/run.js';\nrun();\n");
    await writeFile(join(rootDir, 'src', 'core', 'run.ts'), 'export function run() {}\n');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await initContext(rootDir);
      lines = log.mock.calls.map(args => stripAnsi(args.map(String).join(' ')));
    } finally {
      log.mockRestore();
      write.mockRestore();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    lines = [];
  });

  it('prints one glyph per status line, not two', () => {
    expect(lines.filter(line => isDoubled(line))).toEqual([]);
  });

  it('still reports every generated file', () => {
    // Guards the test above: if init went quiet, "no doubled lines" would pass vacuously.
    expect(lines.filter(l => l.includes('Generated ')).length).toBeGreaterThanOrEqual(5);
    expect(lines.some(l => l.includes('Created .context/ directory'))).toBe(true);
  });
});

/**
 * Most affected call sites are in commands with no runtime test (export, share,
 * watch, workspace, decision, update). Asserting on the source covers every one
 * of them, so the convention cannot regress unnoticed.
 */
describe('logger messages do not carry their own glyph', () => {
  const srcDir = join(import.meta.dirname, '..', 'src');
  const CALL = /(?:logger\.[a-z]+|\.stop)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

  it('every literal message passed to the logger starts with text', () => {
    const offenders: string[] = [];
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.ts'))
      .map(e => join(e.parentPath ?? e.path, e.name));

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const [, , message] of source.matchAll(CALL)) {
        const body = [...messageBody(stripAnsi(message))];
        if (body.length && isGlyph(body[0])) {
          offenders.push(`${file.slice(srcDir.length + 1)}: ${JSON.stringify(message)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
