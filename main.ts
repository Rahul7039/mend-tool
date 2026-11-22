// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does
// sections 1 to 10 of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// three-tier line matching (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, in the patch's order. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files: a file's lines, its line break and whether it ends with one (section 3)
// ---------------------------------------------------------------------------

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

// ---------------------------------------------------------------------------
// Matching lines at three tiers (section 5)
// ---------------------------------------------------------------------------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** Positions i >= from where O matches fileLines at tier; when eof, only occurrences ending at the last line. */
function occurrences(fileLines: string[], O: string[], tier: number, from: number, eof: boolean): number[] {
  const out: number[] = [];
  const last = fileLines.length - O.length;
  for (let i = Math.max(from, 0); i <= last; i++) {
    if (eof && i + O.length !== fileLines.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(fileLines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at least once, with its positions. */
function findTier(fileLines: string[], O: string[], strict: boolean, from: number, eof: boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, O, t, from, eof);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a chunk: a context line, an old line or a new line. */
interface CLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/** Split a chunk's lines into the old lines O and the new lines N (each N line notes its context index in O, or -1). */
function splitChunk(lines: CLine[]): { O: string[]; N: { text: string; ctx: number }[] } {
  const O: string[] = [];
  const N: { text: string; ctx: number }[] = [];
  for (const l of lines) {
    if (l.kind === 'ctx') {
      N.push({ text: l.text, ctx: O.length });
      O.push(l.text);
    } else if (l.kind === 'old') O.push(l.text);
    else N.push({ text: l.text, ctx: -1 });
  }
  return { O, N };
}

/**
 * The lines N writes when O matched at pos: context lines are the file's own matched lines; at tier 2 every
 * other line is re-indented from P (the indent of O's first line) to F (the indent of the file's first matched
 * line); a line that does not start with P is written as it is. When P is empty every non-blank line counts
 * as starting with P, so F is prepended.
 */
function buildNew(fileLines: string[], pos: number, O: string[], N: { text: string; ctx: number }[], tier: number): string[] {
  return N.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    if (tier === 2 && O.length > 0) {
      const F = leadWS(fileLines[pos]!);
      const P = leadWS(O[0]!);
      if (n.text.trim() !== '' && n.text.startsWith(P)) return F + n.text.slice(P.length);
    }
    return n.text;
  });
}

function nearestOcc(occ: number[], target: number): number {
  let best = occ[0]!;
  let bestD = Math.abs(occ[0]! - target);
  for (let k = 1; k < occ.length; k++) {
    const d = Math.abs(occ[k]! - target);
    if (d < bestD) {
      bestD = d;
      best = occ[k]!;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

/** One hunk: A is the old start (1-based); body holds context/old/new lines plus backslash lines. */
interface Hunk {
  A: number;
  body: (CLine | { kind: 'bs'; text: string })[];
  /** A backslash line follows the hunk's last context or new line. */
  noNL: boolean;
}

interface USection {
  oldP: string | null;
  newP: string | null;
  pairNamed: boolean;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: up to the first tab, surrounding spaces removed, one leading a/ or b/ removed. */
function diffPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const n = lines.length;
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldP: m[1]!, newP: m[2]!, pairNamed: false, creation: false, deletion: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.pairNamed) {
        cur.oldP = diffPath(l);
        cur.newP = diffPath(lines[i + 1]!);
        cur.pairNamed = true;
        i += 2;
        continue;
      }
      cur = { oldP: diffPath(l), newP: diffPath(lines[i + 1]!), pairNamed: true, creation: false, deletion: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      i++;
      const body: Hunk['body'] = [];
      while (i < n) {
        const b = lines[i]!;
        // A ---/+++ pair ends the body and starts a new section.
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: 'ctx', text: '', blank: true } as CLine & { blank: boolean });
          i++;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') {
          body.push({ kind: 'ctx', text: b.slice(1) });
          i++;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'old', text: b.slice(1) });
          i++;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'new', text: b.slice(1) });
          i++;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'bs', text: b });
          i++;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it; a space-only line is a context line, not dropped.
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && (last as CLine & { blank?: boolean }).blank === true) body.pop();
        else break;
      }
      let noNL = false;
      for (let k = body.length - 1; k >= 0; k--) {
        const b = body[k]!;
        if (b.kind === 'ctx' || b.kind === 'new') {
          noNL = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
          break;
        }
      }
      cur.hunks.push({ A, body, noNL });
      inHeader = false;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        if (!cur.pairNamed) cur.oldP = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.pairNamed) cur.newP = l.slice(10).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.creation = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.deletion = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // Between hunks: anything else is ignored (prose, code fences).
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSectionEdit(sec, strict, moves));
}

/** Whether a backslash line follows the last new line of the section's hunks (for a created file). */
function creationEndsNoNL(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    let lastPlus = -1;
    for (let k = 0; k < body.length; k++) if (body[k]!.kind === 'new') lastPlus = k;
    if (lastPlus >= 0) return body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.kind === 'bs';
  }
  return false;
}

function unifiedSectionEdit(sec: USection, strict: boolean, moves: Array<[string, string]>): Edit {
  const oldFile = sec.oldP === null || sec.oldP === '/dev/null' ? null : sec.oldP;
  const newFile = sec.newP === null || sec.newP === '/dev/null' ? null : sec.newP;
  const kind = oldFile === null || sec.creation ? 'creation' : newFile === null || sec.deletion ? 'deletion' : oldFile !== newFile ? 'move' : 'change';
  return (tree) => {
    // Safety first, for every path the edit names, old before new; /dev/null is exempt.
    if (oldFile !== null && !safe(oldFile)) throw new Fail('unsafe', oldFile);
    if (newFile !== null && newFile !== oldFile && !safe(newFile)) throw new Fail('unsafe', newFile);
    if (kind === 'creation') {
      if (newFile === null) return;
      if (tree.get(newFile) !== null) throw new Fail('exists', newFile);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      const final = !creationEndsNoNL(sec.hunks);
      tree.now.set(newFile, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (kind === 'deletion') {
      if (oldFile === null) return;
      if (tree.get(oldFile) === null) throw new Fail('missing', oldFile);
      tree.now.set(oldFile, null);
      return;
    }
    // Change or move: the old file exists, and for a move the new path does not.
    const before = tree.get(oldFile!);
    if (before === null) throw new Fail('missing', oldFile!);
    if (kind === 'move' && tree.get(newFile!) !== null) throw new Fail('exists', newFile!);
    const parts = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const chunkLines = h.body.filter((b): b is CLine => b.kind !== 'bs');
      const { O, N } = splitChunk(chunkLines);
      if (O.length === 0) {
        const at = Math.min(h.A + d, parts.lines.length);
        const rep = buildNew(parts.lines, at, O, N, 0);
        const atEnd = at === parts.lines.length;
        parts.lines.splice(at, 0, ...rep);
        if (atEnd) parts.final = !h.noNL;
        d += N.length;
      } else {
        const found = findTier(parts.lines, O, strict, 0, false);
        if (found === null) throw new Fail('no-match', oldFile!);
        const pos = nearestOcc(found.occ, h.A - 1 + d);
        const toEnd = pos + O.length === parts.lines.length;
        const rep = buildNew(parts.lines, pos, O, N, found.tier);
        parts.lines.splice(pos, O.length, ...rep);
        if (toEnd) parts.final = !h.noNL;
        d += N.length - O.length;
      }
    }
    const out = joinFile(parts);
    if (kind === 'move') {
      tree.now.set(oldFile!, null);
      tree.now.set(newFile!, out);
      moves.push([oldFile!, newFile!]);
    } else {
      tree.now.set(oldFile!, out);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const parts = splitFile(cur);
    const found = findTier(parts.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const N = newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = buildNew(parts.lines, pos, oldLines, N, found.tier);
    parts.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(parts));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: CLine[];
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let k = first + 1;
  while (k < last) {
    if (blank(lines[k]!)) {
      k++;
      continue;
    }
    const startLine = lines[k]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (startLine.startsWith('*** Add File: ')) {
      kind = 'add';
      path = startLine.slice(14).trim();
    } else if (startLine.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = startLine.slice(17).trim();
    } else if (startLine.startsWith('*** Update File: ')) {
      kind = 'update';
      path = startLine.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${k + 1}`);
    }
    const startIdx = k;
    k++;
    const raw: { text: string; no: number }[] = [];
    while (k < last && !isSectionStart(lines[k]!)) {
      raw.push({ text: lines[k]!, no: k + 1 });
      k++;
    }
    // Blank lines at the end of a section are not part of it; whitespace-only lines count as blank there.
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let body = raw;
      // *** Move to: counts only as the first line of the section; leading blank lines are not trimmed.
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice(13).trim();
        body = raw.slice(1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (const r of body) {
        const l = r.text;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          cur = null;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push(
            l === ''
              ? { kind: 'ctx', text: '' }
              : l[0] === ' '
                ? { kind: 'ctx', text: l.slice(1) }
                : l[0] === '-'
                  ? { kind: 'old', text: l.slice(1) }
                  : { kind: 'new', text: l.slice(1) },
          );
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startIdx + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findTier(parts.lines, [ch.anchor], strict, cursor, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { O, N } = splitChunk(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? parts.lines.length : cursor;
        const rep = buildNew(parts.lines, at, O, N, 0);
        parts.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
      } else {
        const found = findTier(parts.lines, O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const rep = buildNew(parts.lines, pos, O, N, found.tier);
        parts.lines.splice(pos, O.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = joinFile(parts);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Run (sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const tree = new Tree();
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, tree.moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, tree.moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a successful move prints `R <old> -> <new>` (sorted by the new path) in place of its D and A
  // lines; every other changed path prints A, D or M. A file whose bytes are unchanged is not listed.
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
