// main.ts is mend, the CLI SPEC.md specifies (MIT). It applies an edit that an AI model wrote to a tree of
// text files, in one of four formats: unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A
// patches and JSON tool calls. Lines are matched at the first of three tiers (exact, trailing-whitespace,
// full-whitespace) unless --strict is given, and every change is written or none is.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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
  moves: Array<[string, string]> = [];
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

/** A file split the way section 3 of SPEC.md reads it. */
interface FileLines {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.ends ? f.br : '');
}

/** One body line of a hunk or chunk: context, old-only or new-only, plus the `\` flag of a line after it. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  bs: boolean;
  bare: boolean;
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every start position at or after `from` where O matches the file's lines at `tier`; overlaps allowed. */
function occurrences(file: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  for (let i = from; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(file[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at or after `from`, with every position at that tier. */
function findTier(file: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t += 1) {
    const positions = occurrences(file, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** A new line at tier 2, re-indented from the patch's first old line onto the file's first matched line. */
function reindent(line: string, tier: number, firstFile: string, firstOld: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  const p = leadWs(firstOld);
  if (!line.startsWith(p)) return line;
  return leadWs(firstFile) + line.slice(p.length);
}

/** The lines a hunk or chunk writes over the match at `pos`: context from the file itself, adds as written. */
function renderOps(file: string[], pos: number, ops: Op[], tier: number, o: string[]): string[] {
  const out: string[] = [];
  let consumed = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(file[pos + consumed]!);
      consumed += 1;
    } else if (op.kind === 'del') {
      consumed += 1;
    } else {
      out.push(reindent(op.text, tier, file[pos] ?? '', o[0] ?? ''));
    }
  }
  return out;
}

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

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  ops: Op[];
}
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minus: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

function headerPath(raw: string): string {
  let t = raw;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSection = (): Section => {
    const s: Section = { gitOld: null, gitNew: null, minus: null, plus: null, renameFrom: null, renameTo: null, isNew: false, isDel: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${ln}`);
      const ops: Op[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = bl[0];
        if (bl === '') {
          ops.push({ kind: 'ctx', text: '', bs: false, bare: true });
          i += 1;
        } else if (c === ' ') {
          ops.push({ kind: 'ctx', text: bl.slice(1), bs: false, bare: false });
          i += 1;
        } else if (c === '-') {
          ops.push({ kind: 'del', text: bl.slice(1), bs: false, bare: false });
          i += 1;
        } else if (c === '+') {
          ops.push({ kind: 'add', text: bl.slice(1), bs: false, bare: false });
          i += 1;
        } else if (c === '\\') {
          if (ops.length > 0) ops[ops.length - 1]!.bs = true;
          i += 1;
        } else break;
      }
      while (ops.length > 0 && ops[ops.length - 1]!.bare) ops.pop();
      cur.hunks.push({ a: parseInt(hm[1]!, 10), ops });
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && cur.minus === null) {
          cur.minus = headerPath(line.slice(4));
          cur.plus = headerPath(next.slice(4));
        } else {
          cur = newSection();
          cur.minus = headerPath(line.slice(4));
          cur.plus = headerPath(next.slice(4));
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${ln + 1}`);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10);
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null;
    let newP: string | null;
    if (s.minus !== null) {
      oldP = s.minus === '/dev/null' ? null : stripPrefix(s.minus);
      newP = s.plus === '/dev/null' ? null : stripPrefix(s.plus!);
    } else {
      oldP = s.renameFrom ?? s.gitOld;
      newP = s.renameTo ?? s.gitNew;
    }
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const creation = oldP === null || s.isNew;
    const deletion = newP === null || s.isDel;
    if (creation) {
      if (newP === null) throw new Fail('missing', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      let lastBs = false;
      for (const h of s.hunks) {
        for (const op of h.ops) {
          if (op.kind === 'add') {
            out.push(op.text);
            lastBs = op.bs;
          }
        }
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (deletion) {
      if (oldP === null) throw new Fail('missing', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) throw new Fail('missing', '');
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const isMove = oldP !== newP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const o: string[] = [];
      for (const op of h.ops) if (op.kind !== 'add') o.push(op.text);
      if (o.length === 0) {
        const adds = h.ops.filter((op) => op.kind === 'add');
        const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
        const atEnd = pos === f.lines.length;
        f.lines.splice(pos, 0, ...adds.map((op) => op.text));
        if (atEnd && adds.length > 0) f.ends = !adds[adds.length - 1]!.bs;
        d += adds.length;
      } else {
        const found = findTier(f.lines, o, strict, 0);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const rendered = renderOps(f.lines, best, h.ops, found.tier, o);
        const touchesEnd = best + o.length === f.lines.length;
        f.lines.splice(best, o.length, ...rendered);
        if (touchesEnd) {
          const lastCp = [...h.ops].reverse().find((op) => op.kind === 'ctx' || op.kind === 'add');
          f.ends = !(lastCp?.bs ?? false);
        }
        d += rendered.length - o.length;
      }
    }
    const text = joinFile(f);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLn = i + 1;
    let p: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      p = tr;
      break;
    }
    if (p === null) {
      if (prevPath !== null) p = prevPath;
      else throw new Exit2(`error: parse ${searchLn}`);
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLn}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLn}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const path = p;
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const rendered = newLines.map((l) => reindent(l, found.tier, f.lines[pos]!, oldLines[0]!));
      f.lines.splice(pos, oldLines.length, ...rendered);
      tree.now.set(path, joinFile(f));
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface VChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  headerLn: number;
}

function v4aHeader(l: string): { kind: 'add' | 'del' | 'update'; path: string } | null {
  if (l.startsWith('*** Add File:')) return { kind: 'add', path: l.slice(13).trim() };
  if (l.startsWith('*** Delete File:')) return { kind: 'del', path: l.slice(16).trim() };
  if (l.startsWith('*** Update File:')) return { kind: 'update', path: l.slice(16).trim() };
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const h = v4aHeader(line);
    if (h === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind: h.kind, path: h.path, moveTo: null, addLines: [], chunks: [], headerLn: i + 1 };
    sections.push(sec);
    i += 1;
    if (h.kind === 'add') {
      const collected: Array<{ text: string; bare: boolean }> = [];
      while (i < last) {
        const l = lines[i]!;
        if (v4aHeader(l) !== null) break;
        if (l.startsWith('+')) {
          collected.push({ text: l.slice(1), bare: false });
          i += 1;
        } else if (l === '') {
          collected.push({ text: '', bare: true });
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (collected.length > 0 && collected[collected.length - 1]!.bare) collected.pop();
      sec.addLines = collected.map((c) => c.text);
    } else if (h.kind === 'del') {
      while (i < last && blank(lines[i]!)) i += 1;
      if (i < last && v4aHeader(lines[i]!) === null) throw new Exit2(`error: parse ${i + 1}`);
    } else {
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        sec.moveTo = lines[i]!.slice(12).trim();
        i += 1;
      }
      let chunk: VChunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        if (v4aHeader(l) !== null) break;
        if (l.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, ops: [], eof: false };
            sec.chunks.push(chunk);
          }
          chunk.eof = true;
          chunk = null;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), ops: [], eof: false };
          sec.chunks.push(chunk);
          i += 1;
          continue;
        }
        const c = l[0];
        if (l === '' || c === ' ' || c === '-' || c === '+') {
          if (chunk === null) {
            chunk = { anchor: null, ops: [], eof: false };
            sec.chunks.push(chunk);
          }
          chunk.ops.push({
            kind: l === '' || c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add',
            text: l === '' ? '' : l.slice(1),
            bs: false,
            bare: l === '',
          });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (sec.chunks.length > 0) {
        const tail = sec.chunks[sec.chunks.length - 1]!;
        // Blank lines at the end of a section are not part of it: a context line holding no text came
        // from a whitespace-only line, so it goes too, not only a bare empty line.
        while (tail.ops.length > 0) {
          const lastOp = tail.ops[tail.ops.length - 1]!;
          if (lastOp.bare || (lastOp.kind === 'ctx' && lastOp.text === '')) tail.ops.pop();
          else break;
        }
        if (tail.ops.length === 0 && tail.anchor === null && !tail.eof) {
          sec.chunks.pop();
          continue;
        }
        break;
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.headerLn}`);
    }
  }
  return sections.map((sec) => v4aEdit(sec, strict));
}

function findAnchor(file: string[], anchor: string, strict: boolean, cursor: number): number {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t += 1) {
    for (let j = cursor; j < file.length; j += 1) {
      if (lineEq(file[j]!, anchor, t)) return j;
    }
  }
  return -1;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const ai = findAnchor(f.lines, ch.anchor, strict, cursor);
        if (ai < 0) throw new Fail('no-match', sec.path);
        cursor = ai + 1;
      }
      const o: string[] = [];
      for (const op of ch.ops) if (op.kind !== 'add') o.push(op.text);
      if (o.length === 0) {
        const adds = ch.ops.filter((op) => op.kind === 'add').map((op) => op.text);
        const pos = ch.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
      } else {
        const maxTier = strict ? 0 : 2;
        let chosen: { tier: number; pos: number } | null = null;
        for (let t = 0; t <= maxTier && chosen === null; t += 1) {
          const poss = occurrences(f.lines, o, t, cursor).filter((p) => !ch.eof || p + o.length === f.lines.length);
          if (poss.length > 0) chosen = { tier: t, pos: poss[0]! };
        }
        if (chosen === null) throw new Fail('no-match', sec.path);
        const rendered = renderOps(f.lines, chosen.pos, ch.ops, chosen.tier, o);
        f.lines.splice(chosen.pos, o.length, ...rendered);
        cursor = chosen.pos + rendered.length;
      }
    }
    const text = joinFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

// ---------------------------------------------------------------- JSON edits (section 9)

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
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
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
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- invocation, output, atomicity (sections 1, 2, 10)

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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
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
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const used = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (used.has(oldP) || used.has(newP)) continue;
    const co = changed.get(oldP);
    const cn = changed.get(newP);
    if (co !== undefined && cn !== undefined && co.was !== null && co.now === null && cn.was === null && cn.now !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of [...changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
