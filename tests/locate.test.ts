import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { tokenize, locateInMap, scanContent, formatLocateText } from '../src/core/locate.js';
import { buildMap } from '../src/core/map-scanner.js';
import type { CodeMap, Decisions, MapFile } from '../src/schema/index.js';

const f = (file: string, extra: Partial<MapFile> = {}): MapFile => ({ file, lang: 'ts', lines: 100, ...extra });

const map: CodeMap = {
  $schema: 'https://adjective.us/prelude/schemas/v1/map.schema.json',
  version: '1.0.0',
  stats: { files: 12, modules: 5, edges: 20, unresolvedImports: 0 },
  modules: [
    {
      path: 'src/commands',
      purpose: 'Command handlers',
      fileCount: 3,
      files: [
        f('src/commands/init.ts', { exports: ['registerInitCommand', 'initContext'], importedBy: 1, rank: 0.1 }),
        f('src/commands/serve.ts', { exports: ['registerServeCommand'], importedBy: 1, rank: 0.1 }),
        f('src/commands/update.ts', { exports: ['update'], importedBy: 1, rank: 0.1 }),
      ],
    },
    {
      path: 'src/core',
      purpose: 'Core business logic',
      fileCount: 4,
      files: [
        f('src/core/infer.ts', { exports: ['inferProjectMetadata', 'inferStack', 'inferArchitecture', 'inferConstraints'], importedBy: 3, rank: 0.25 }),
        f('src/core/merger.ts', { exports: ['ContextMerger', 'MergeResult', 'MergeChange'], importedBy: 2, rank: 0.17 }),
        f('src/core/query-engine.ts', { exports: ['executeQuery', 'exportCompact', 'VALID_TYPES'], importedBy: 3, rank: 0.25 }),
        f('src/core/state-manager.ts', { exports: ['StateManager'], importedBy: 2, rank: 0.17 }),
      ],
    },
    {
      path: 'src/mcp',
      purpose: 'MCP server',
      fileCount: 1,
      files: [f('src/mcp/server.ts', { exports: ['createPreludeServer'], importedBy: 1, rank: 0.08 })],
    },
    {
      path: 'src/utils',
      purpose: 'Utility functions',
      fileCount: 2,
      files: [
        f('src/utils/fs.ts', { exports: ['readJSON', 'writeJSON', 'fileExists'], importedBy: 12, rank: 1 }),
        f('src/utils/log.ts', { exports: ['logger', 'spinner'], importedBy: 9, rank: 0.75 }),
      ],
    },
    {
      path: 'tests',
      purpose: 'Tests',
      fileCount: 2,
      files: [
        f('tests/query.test.ts', { isTest: true }),
        f('tests/merge-preserve.test.ts', { isTest: true }),
      ],
    },
  ],
  hubs: [{ file: 'src/utils/fs.ts', importedBy: 12, rank: 1 }],
};

const decisions: Decisions = {
  $schema: 'https://adjective.us/prelude/schemas/v1/decisions.json',
  version: '1.0.0',
  decisions: [
    {
      id: 'd1',
      timestamp: '2025-01-01T00:00:00.000Z',
      title: 'Manual edits are sacred',
      status: 'accepted',
      rationale: 'src/core/merger.ts and src/core/state-manager.ts preserve manual edits during prelude update.',
    },
  ],
};

describe('tokenize', () => {
  it('splits camelCase, drops stopwords, and singularises', () => {
    expect(tokenize('How does inferArchitecture handle the tests?')).toEqual(['infer', 'architecture', 'handle', 'test']);
  });
});

describe('locateInMap', () => {
  it('finds infer.ts for "architecture inference"', () => {
    const hits = locateInMap(map, 'architecture inference');
    expect(hits[0].file).toBe('src/core/infer.ts');
    expect(hits[0].reasons).toContain('export inferArchitecture');
  });

  it('finds the MCP server first for "mcp server tools"', () => {
    expect(locateInMap(map, 'mcp server tools')[0].file).toBe('src/mcp/server.ts');
  });

  it('uses decisions to surface merger and state-manager', () => {
    const hits = locateInMap(map, 'preserve manual edits during update', {}, { decisions });
    const top3 = hits.slice(0, 3).map(h => h.file);
    expect(top3).toContain('src/core/merger.ts');
    expect(top3).toContain('src/core/state-manager.ts');
    expect(hits.find(h => h.file === 'src/core/merger.ts')?.reasons).toContain('decision: Manual edits are sacred');
  });

  it('admits test files only when the query mentions tests', () => {
    expect(locateInMap(map, 'query engine tests').map(h => h.file)).toContain('tests/query.test.ts');
    expect(locateInMap(map, 'query engine').map(h => h.file)).not.toContain('tests/query.test.ts');
  });

  it('restricts to a scope', () => {
    const hits = locateInMap(map, 'update merge infer', { scope: 'src/commands' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.file.startsWith('src/commands/'))).toBe(true);
  });

  it('returns [] when nothing matches', () => {
    expect(locateInMap(map, 'zzzz qqqq')).toEqual([]);
  });

  it('breaks ties by rank', () => {
    const tie: CodeMap = {
      ...map,
      modules: [{
        path: 'lib',
        fileCount: 2,
        files: [f('lib/a.ts', { exports: ['widget'], rank: 0.2 }), f('lib/b.ts', { exports: ['widget'], rank: 0.9 })],
      }],
    };
    expect(locateInMap(tie, 'widget').map(h => h.file)).toEqual(['lib/b.ts', 'lib/a.ts']);
  });

  it('honours the limit', () => {
    expect(locateInMap(map, 'src core commands utils', { limit: 2 })).toHaveLength(2);
  });
});

describe('scanContent', () => {
  let rootDir: string;
  let fixtureMap: CodeMap;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'prelude-locate-content-'));
    await mkdir(join(rootDir, 'src'), { recursive: true });
    await mkdir(join(rootDir, 'tests'), { recursive: true });
    // The word "invoice" appears only inside a function body, never in a name or path.
    await writeFile(join(rootDir, 'src', 'ledger.ts'), 'export function post() {\n  // rounds each invoice line; Invoice totals are summed later\n  return 1;\n}\n');
    await writeFile(join(rootDir, 'src', 'report.ts'), 'export function render() {\n  return "summary";\n}\n');
    await writeFile(join(rootDir, 'tests', 'ledger.test.ts'), 'import { post } from "../src/ledger.js";\n// invoice fixtures\npost();\n');
    fixtureMap = await buildMap(rootDir);
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('finds a term that only appears inside a file body', async () => {
    expect(locateInMap(fixtureMap, 'invoice rounding')).toEqual([]);

    const content = await scanContent(rootDir, fixtureMap, 'invoice rounding');
    expect(content.get('src/ledger.ts')?.get('invoice')).toBe(2);
    expect(content.has('src/report.ts')).toBe(false);

    const hits = locateInMap(fixtureMap, 'invoice rounding', {}, { content });
    expect(hits[0].file).toBe('src/ledger.ts');
    expect(hits[0].reasons).toContain('content invoice×2');
  });

  it('skips test files unless asked', async () => {
    expect((await scanContent(rootDir, fixtureMap, 'invoice')).has('tests/ledger.test.ts')).toBe(false);
    expect((await scanContent(rootDir, fixtureMap, 'invoice', { includeTests: true })).has('tests/ledger.test.ts')).toBe(true);
  });

  it('honours scope', async () => {
    const content = await scanContent(rootDir, fixtureMap, 'invoice', { scope: 'tests', includeTests: true });
    expect([...content.keys()]).toEqual(['tests/ledger.test.ts']);
  });

  it('ignores files the map lists but the disk no longer has', async () => {
    const stale: CodeMap = JSON.parse(JSON.stringify(fixtureMap));
    stale.modules[0].files.push({ file: 'src/gone.ts', lang: 'ts', lines: 1 });
    await expect(scanContent(rootDir, stale, 'invoice')).resolves.toBeInstanceOf(Map);
  });

  it('keeps name matches ahead of a passing mention', async () => {
    // report.ts is named for the query; ledger.ts would only match on content.
    const content = await scanContent(rootDir, fixtureMap, 'report render');
    expect(locateInMap(fixtureMap, 'report render', {}, { content })[0].file).toBe('src/report.ts');
  });
});

describe('locate result context', () => {
  const ctxMap: CodeMap = {
    $schema: 'x',
    version: '1.0.0',
    stats: { files: 4, modules: 2, edges: 2, unresolvedImports: 0 },
    modules: [
      {
        path: 'src/billing',
        notes: 'Amounts are integer cents',
        fileCount: 2,
        files: [
          { file: 'src/billing/invoice.ts', lang: 'ts', lines: 10, exports: ['createInvoice'], importedBy: 2 },
          { file: 'src/billing/refund.ts', lang: 'ts', lines: 10, exports: ['refundInvoice'] },
        ],
        tests: ['tests/billing.test.ts'],
      },
      {
        path: 'tests',
        fileCount: 2,
        files: [
          { file: 'tests/billing.test.ts', lang: 'ts', lines: 5, isTest: true },
          { file: 'tests/invoice.test.ts', lang: 'ts', lines: 5, isTest: true, imports: ['src/billing/invoice.ts'] },
        ],
      },
    ],
  };
  const ctxDecisions = {
    decisions: [{ id: '1', timestamp: 't', title: 'Invoices are immutable', status: 'accepted', rationale: 'src/billing/invoice.ts never updates a row.' }],
  } as unknown as Decisions;

  it('attaches tests, decisions, and notes to each hit', () => {
    const hits = locateInMap(ctxMap, 'invoice', {}, { decisions: ctxDecisions });
    const invoice = hits.find(h => h.file === 'src/billing/invoice.ts')!;
    expect(invoice.tests).toEqual(['tests/invoice.test.ts']);       // the test that imports it
    expect(invoice.decisions).toEqual(['Invoices are immutable']);
    expect(invoice.notes).toBe('Amounts are integer cents');

    const refund = hits.find(h => h.file === 'src/billing/refund.ts')!;
    expect(refund.tests).toEqual(['tests/billing.test.ts']);        // falls back to the module's tests
    expect(refund.decisions).toBeUndefined();
  });

  it('renders impact, decisions, and notes lines', () => {
    const out = formatLocateText(locateInMap(ctxMap, 'createInvoice', { limit: 1 }, { decisions: ctxDecisions }), 'createInvoice');
    expect(out).toContain('   impact: imported by 2 files  ·  tests: tests/invoice.test.ts\n');
    expect(out).toContain('   decisions: Invoices are immutable\n');
    expect(out).toContain('   notes: Amounts are integer cents\n');
  });

  it('omits the extra lines when there is nothing to say', () => {
    const bare: CodeMap = { ...ctxMap, modules: [{ path: 'lib', fileCount: 1, files: [{ file: 'lib/a.ts', lang: 'ts', lines: 1, exports: ['widget'] }] }] };
    const out = formatLocateText(locateInMap(bare, 'widget'), 'widget');
    expect(out).not.toMatch(/impact:|decisions:|notes:/);
  });
});
