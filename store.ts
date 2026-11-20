// In-memory store for the forge: git objects, refs, repos, issues and pull requests.
// Everything is deterministic: ids are sequential, timestamps come from a counter,
// and no wall clock or randomness is used anywhere in this file.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer }

export function sha1Object(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitBytes(c: CommitInfo): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(s, 'utf8');
}

export function ident(ts: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
}

export interface IssueComment { id: number; body: string }
export interface Issue {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; comments: IssueComment[]; seq: number;
}
export interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number }
export interface Pull {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; head: { ref: string; sha: string }; base: { ref: string; sha: string };
  baseSha: string; merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  files: PullFile[];
}

export interface Repo {
  id: number; name: string; owner: string; private: boolean; description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[]; pulls: Pull[];
  issueSeq: number; pullSeq: number; commentSeq: number;
  snapshots: Map<string, Map<string, Buffer>>; // ref -> path -> file bytes
}

function countLines(b: Buffer): number {
  if (b.length === 0) return 0;
  const lines = b.toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function lineDiff(a: Buffer, b: Buffer): { additions: number; deletions: number } {
  const la = a.toString('utf8').split('\n');
  const lb = b.toString('utf8').split('\n');
  if (la.length && la[la.length - 1] === '') la.pop();
  if (lb.length && lb[lb.length - 1] === '') lb.pop();
  const ca = new Map<string, number>();
  for (const l of la) ca.set(l, (ca.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of lb) {
    const n = ca.get(l) ?? 0;
    if (n > 0) ca.set(l, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of ca.values()) deletions += n;
  return { additions, deletions };
}

export function diffFiles(a: Map<string, Buffer>, b: Map<string, Buffer>): PullFile[] {
  const out: PullFile[] = [];
  const names = new Set([...a.keys(), ...b.keys()]);
  for (const name of [...names].sort()) {
    const av = a.get(name);
    const bv = b.get(name);
    if (av && !bv) {
      const deletions = countLines(av);
      out.push({ filename: name, status: 'deleted', additions: 0, deletions, changes: deletions });
    } else if (!av && bv) {
      const additions = countLines(bv);
      out.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
    } else if (av && bv && !av.equals(bv)) {
      const d = lineDiff(av, bv);
      out.push({ filename: name, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  repoIdSeq = 5000;
  issueIdSeq = 9000;
  pullIdSeq = 8000;
  private clock = 0;

  now(): number {
    // Deterministic clock: fixed epoch plus a counter, so two runs agree.
    this.clock += 1;
    return 1700000000 + this.clock;
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = sha1Object(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.repoIdSeq++, name, owner, private: isPrivate, description: description ?? '',
      defaultBranch: 'main', refs: new Map(), labels: new Map(),
      issues: [], pulls: [], issueSeq: 0, pullSeq: 0, commentSeq: 0,
      snapshots: new Map(),
    };
    for (const label of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
      repo.labels.set(label, { name: label, color: 'ededed' });
    }
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // Build (and store) a tree for a flat path -> bytes map. Returns the tree oid.
  buildTreeFromFiles(files: Map<string, Buffer>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, Buffer>>();
      for (const [path, content] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          const blob = this.putObject('blob', content);
          entries.push({ mode: '100644', name: rest, oid: blob });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) { sub = new Map(); dirs.set(dir, sub); }
          sub.set(path, content);
        }
      }
      for (const [dir, sub] of dirs) {
        const oid = build(prefix + dir + '/');
        entries.push({ mode: '40000', name: dir, oid });
      }
      entries.sort((x, y) => {
        const a = x.mode === '40000' ? x.name + '/' : x.name;
        const b = y.mode === '40000' ? y.name + '/' : y.name;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      return this.putObject('tree', buildTreeBytes(entries));
    };
    return build('');
  }

  // Flat path -> bytes map for the tree at a commit oid.
  filesAtCommit(commitOid: string): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const obj = this.getObject(commitOid);
    if (!obj || obj.type !== 'commit') return out;
    const info = parseCommit(obj.data);
    const walk = (treeOid: string, prefix: string): void => {
      const t = this.getObject(treeOid);
      if (!t || t.type !== 'tree') return;
      for (const e of parseTree(t.data)) {
        if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
        else {
          const b = this.getObject(e.oid);
          if (b) out.set(prefix + e.name, b.data);
        }
      }
    };
    walk(info.tree, '');
    return out;
  }

  // Create a commit on a ref from a full file map. Updates the ref and its snapshot.
  createCommit(repo: Repo, ref: string, files: Map<string, Buffer>, message: string, parents: string[]): string {
    const tree = this.buildTreeFromFiles(files);
    const ts = this.now();
    const oid = this.putObject('commit', buildCommitBytes({
      tree, parents, author: ident(ts), committer: ident(ts), message,
    }));
    repo.refs.set(ref, oid);
    repo.snapshots.set(ref, new Map(files));
    return oid;
  }

  // Walk parents from `from`; true when `target` is reachable (including equality).
  isAncestor(target: string, from: string): boolean {
    if (target === from) return true;
    if (target === ZERO_OID) return true;
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.getObject(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  // All commit oids reachable from `from` (inclusive), in discovery order.
  reachableCommits(from: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur) || cur === ZERO_OID) continue;
      seen.add(cur);
      const obj = this.getObject(cur);
      if (!obj || obj.type !== 'commit') continue;
      out.push(cur);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return out;
  }

  globalId(kind: string, key: string): string {
    return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
  }

  repoGlobalId(repo: Repo): string {
    return this.globalId('repo', `${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return this.globalId('issue', `${repo.id}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return this.globalId('pull', `${repo.id}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return this.globalId('comment', `${repo.id}:${issue.number}:${comment.id}`);
  }
}
