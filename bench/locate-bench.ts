/**
 * locate benchmark — replays a repository's own history as a retrieval task.
 *
 * For each sampled commit, the commit subject is the query and the source
 * files that commit changed are the expected answer. The repo is checked out
 * at the commit's parent, so neither method sees the change itself.
 *
 *   locate   buildMap() + locateInMap(), top N
 *   grep     `git grep -i -c` per query token over the same source files,
 *            ranked by distinct tokens matched, then total matches, top N
 *
 * Usage: tsx bench/locate-bench.ts <repo-dir>... [--commits 100] [--limit 8] [--json]
 *
 * The target repos are left on a detached HEAD at their original commit.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import { buildMap } from '../src/core/map-scanner.js';
import { locateInMap, tokenize } from '../src/core/locate.js';
import { isTestFile } from '../src/core/source-scanner.js';

const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs'];
const SKIP_SUBJECT = /^(merge|revert|release|bump|version|chore|docs?|ci|build|style|typo|changelog|v?\d+\.\d+)/i;
const MAX_EXPECTED = 5;
const MIN_TOKENS = 2;

interface Sample {
  sha: string;
  query: string;
  expected: string[];
}

interface Score {
  hit1: number;
  hitN: number;
  recall: number;
  mrr: number;
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // git grep exits 1 when nothing matches
    const out = (err as { stdout?: string }).stdout;
    return typeof out === 'string' ? out : '';
  }
}

function isSource(file: string): boolean {
  return SOURCE_EXT.some(ext => file.endsWith(ext)) && !isTestFile(file);
}

/** "fix(jsx): handle null child (#123)" -> "jsx handle null child" */
function cleanSubject(subject: string): string {
  return subject
    .replace(/\(#\d+\)\s*$/, '')
    .replace(/^(\w+)(?:\(([^)]*)\))?!?:\s*/, (_m, _type, scope) => (scope ? `${scope} ` : ''))
    .trim();
}

function sampleCommits(repo: string, want: number): Sample[] {
  const samples: Sample[] = [];
  // Leave the oldest commits alone: in a shallow clone their parents are missing.
  const log = git(repo, ['log', '--no-merges', '--format=%H%x09%s', '-n', '500']).trim().split('\n');
  for (const line of log) {
    if (samples.length >= want) break;
    const [sha, subject] = line.split('\t');
    if (!sha || !subject || SKIP_SUBJECT.test(subject)) continue;
    const query = cleanSubject(subject);
    if (tokenize(query).length < MIN_TOKENS) continue;
    if (!git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^`]).trim()) continue;

    const changed = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
      .trim().split('\n').filter(isSource);
    if (changed.length === 0 || changed.length > MAX_EXPECTED) continue;
    // Only files that already existed: a brand-new file cannot be located.
    const existing = git(repo, ['ls-tree', '-r', '--name-only', `${sha}^`, '--', ...changed])
      .trim().split('\n').filter(Boolean);
    if (existing.length === 0) continue;
    samples.push({ sha, query, expected: existing });
  }
  return samples;
}

function grepRank(repo: string, query: string, limit: number): { top: string[]; candidates: number } {
  const perFile = new Map<string, { distinct: number; total: number }>();
  for (const token of tokenize(query)) {
    const out = git(repo, ['grep', '-I', '-i', '-c', '-F', '-e', token, '--', ...SOURCE_EXT.map(e => `*${e}`)]);
    for (const line of out.split('\n')) {
      const idx = line.lastIndexOf(':');
      if (idx < 0) continue;
      const file = line.slice(0, idx);
      if (!isSource(file)) continue;
      const entry = perFile.get(file) ?? { distinct: 0, total: 0 };
      entry.distinct += 1;
      entry.total += Number(line.slice(idx + 1)) || 0;
      perFile.set(file, entry);
    }
  }
  const ranked = [...perFile.entries()].sort(
    (a, b) => b[1].distinct - a[1].distinct || b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1)
  );
  return { top: ranked.slice(0, limit).map(([file]) => file), candidates: ranked.length };
}

function score(top: string[], expected: string[]): Score {
  const want = new Set(expected);
  const first = top.findIndex(f => want.has(f));
  return {
    hit1: first === 0 ? 1 : 0,
    hitN: first >= 0 ? 1 : 0,
    recall: top.filter(f => want.has(f)).length / want.size,
    mrr: first >= 0 ? 1 / (first + 1) : 0,
  };
}

function mean(scores: Score[], key: keyof Score): number {
  return scores.length === 0 ? 0 : scores.reduce((sum, s) => sum + s[key], 0) / scores.length;
}

function summarize(scores: Score[]) {
  return {
    hit1: mean(scores, 'hit1'),
    hitN: mean(scores, 'hitN'),
    recall: mean(scores, 'recall'),
    mrr: mean(scores, 'mrr'),
  };
}

async function benchRepo(repo: string, commits: number, limit: number) {
  const original = git(repo, ['rev-parse', 'HEAD']).trim();
  const samples = sampleCommits(repo, commits);
  const locateScores: Score[] = [];
  const grepScores: Score[] = [];
  let grepCandidates = 0;
  let sourceFiles = 0;

  try {
    for (const sample of samples) {
      git(repo, ['checkout', '-q', '--detach', `${sample.sha}^`]);
      const map = await buildMap(repo);
      sourceFiles += map.stats.files;
      const hits = locateInMap(map, sample.query, { limit, includeTests: false });
      locateScores.push(score(hits.map(h => h.file), sample.expected));

      const grep = grepRank(repo, sample.query, limit);
      grepCandidates += grep.candidates;
      grepScores.push(score(grep.top, sample.expected));
    }
  } finally {
    git(repo, ['checkout', '-q', '--detach', original]);
  }

  return {
    repo: basename(repo),
    commits: samples.length,
    avgSourceFiles: samples.length ? Math.round(sourceFiles / samples.length) : 0,
    avgGrepCandidates: samples.length ? Math.round(grepCandidates / samples.length) : 0,
    locate: summarize(locateScores),
    grep: summarize(grepScores),
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number): number => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : fallback;
  };
  const commits = flag('--commits', 100);
  const limit = flag('--limit', 8);
  const asJson = args.includes('--json');
  const repos = args.filter((a, i) => !a.startsWith('--') && !['--commits', '--limit'].includes(args[i - 1]));

  if (repos.length === 0) {
    console.error('Usage: tsx bench/locate-bench.ts <repo-dir>... [--commits 100] [--limit 8] [--json]');
    process.exit(1);
  }

  const results = [];
  for (const repo of repos) {
    const dir = resolve(repo);
    if (!existsSync(join(dir, '.git'))) {
      console.error(`${repo}: not a git repository, skipped`);
      continue;
    }
    results.push(await benchRepo(dir, commits, limit));
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(`| Repo | Commits | Source files | Method | Hit@1 | Hit@${limit} | Recall@${limit} | MRR |`);
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    for (const method of ['locate', 'grep'] as const) {
      const s = r[method];
      console.log(
        `| ${r.repo} | ${r.commits} | ${r.avgSourceFiles} | ${method} | ${pct(s.hit1)} | ${pct(s.hitN)} | ${pct(s.recall)} | ${s.mrr.toFixed(2)} |`
      );
    }
  }
  console.log('');
  for (const r of results) {
    console.log(`${r.repo}: grep matched ${r.avgGrepCandidates} files per query on average before ranking`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
