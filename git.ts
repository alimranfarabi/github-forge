// Git smart HTTP: protocol v2 ls-refs/fetch, v0 upload-pack/receive-pack.
import { createHash } from 'node:crypto';
import {
  pktLine, pktFlush, pktDelim, encodePktLines, decodePktLines, sidebandWrap,
  readPack, writePack, verifyPackChecksum, ZERO_OID,
} from './gitproto.ts';
import {
  Store, parseCommit, parseTree, type GitObject, type Repo,
} from './store.ts';

const AGENT = 'forge/1.0';

interface RefInfo { oid: string; name: string; peeled?: string; symrefTarget?: string; unborn?: boolean }

function listRefs(store: Store, repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const main = repo.refs.get('refs/heads/main');
  if (main) out.push({ oid: main, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const entry: RefInfo = { oid, name: ref };
    const obj = store.getObject(oid);
    if (obj && obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = text.match(/^object ([0-9a-f]{40})/m);
      if (m) entry.peeled = m[1];
    }
    out.push(entry);
  }
  return out;
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n', 'flush',
    'version 2\n', 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'object-format=sha1\n', `agent=${AGENT}\n`, 'flush',
  ]);
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack'
    ? 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0'
    : 'side-band-64k multi_ack multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1.0';
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = listRefs(store, repo).filter((r) => r.name !== 'HEAD');
  if (!refs.length) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((r, i) => {
      const line = `${r.oid} ${r.name}${i === 0 ? `\0${caps}` : ''}\n`;
      lines.push(line);
      if (r.peeled) lines.push(`${r.peeled} ${r.name}^{}\n`);
    });
    // HEAD first in real git; the parser takes caps from line 0, which is the first ref.
    // Reorder so HEAD's line carries the caps instead: rebuild with HEAD first.
    const main = repo.refs.get('refs/heads/main');
    if (main) {
      const headLine = `${main} HEAD\0${caps}\n`;
      lines.splice(2, 0, headLine);
      // Remove caps from the old first ref line (now at index 3).
      const oldFirst = lines[3] as string;
      lines[3] = oldFirst.replace(/\0.*\n$/, '\n');
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function resolveWant(store: Store, oid: string): { commit: string | null; tag: string | null } {
  const obj = store.getObject(oid);
  if (!obj) return { commit: null, tag: null };
  if (obj.type === 'commit') return { commit: oid, tag: null };
  if (obj.type === 'tag') {
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
    return { commit: m ? m[1] : null, tag: oid };
  }
  return { commit: null, tag: null };
}

// Collect the objects to send for a fetch. Returns commits to send, extra tag
// objects, the shallow/unshallow boundary lists, and the object ids the
// client already holds (the full closure of its haves), which must not be
// re-sent.
function planFetch(
  store: Store, repo: Repo,
  wants: string[], haves: string[],
  depth: number | null, deepen: number | null,
  shallowBoundary: readonly string[] = [],
): { commits: string[]; tags: string[]; shallow: string[]; unshallow: string[]; held: Set<string> } {
  const wantCommits: string[] = [];
  const tags: string[] = [];
  for (const w of wants) {
    const r = resolveWant(store, w);
    if (r.commit) wantCommits.push(r.commit);
    if (r.tag) tags.push(r.tag);
  }
  const haveSet = new Set<string>();
  for (const h of haves) for (const c of store.reachableCommits(h)) haveSet.add(c);
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wantCommits) {
    if (!dist.has(w)) { dist.set(w, 0); queue.push(w); }
  }
  const order: string[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    const obj = store.getObject(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p)) { dist.set(p, dist.get(cur)! + 1); queue.push(p); }
    }
  }
  let toSend = new Set<string>();
  let shallow: string[] = [];
  let unshallow: string[] = [];
  const fullHave = haveSet;
  if (depth !== null && deepen === null) {
    for (const c of order) if ((dist.get(c) ?? 0) < depth) toSend.add(c);
    for (const c of toSend) {
      const obj = store.getObject(c);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (!parents.length || parents.some((p) => !toSend.has(p))) shallow.push(c);
    }
  } else if (deepen !== null && haves.length) {
    // New commits the client has never seen, plus deepen-1 generations of
    // ancestors beyond the client's shallow boundary.
    for (const c of order) if (!fullHave.has(c)) toSend.add(c);
    for (const h of haves) {
      let frontier = [h];
      for (let d = 1; d < deepen; d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          const obj = store.getObject(cur);
          if (!obj || obj.type !== 'commit') continue;
          for (const p of parseCommit(obj.data).parents) {
            if (dist.has(p) && !toSend.has(p)) { toSend.add(p); next.push(p); }
          }
        }
        frontier = next;
      }
    }
    for (const c of toSend) {
      const obj = store.getObject(c);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (!parents.length || parents.some((p) => !toSend.has(p))) shallow.push(c);
    }
    for (const h of haves) {
      const obj = store.getObject(h);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.some((p) => toSend.has(p))) unshallow.push(h);
    }
  } else {
    for (const c of order) if (!fullHave.has(c)) toSend.add(c);
  }
  // Deterministic order: by distance then oid.
  const commits = [...toSend].sort((a, b) => (dist.get(a) ?? 0) - (dist.get(b) ?? 0) || (a < b ? -1 : 1));
  // Everything the client already holds: the object closure of its haves,
  // stopping at the client's shallow boundary (a shallow clone holds the
  // boundary commit's tree, but not the boundary's parents).
  const boundary = new Set(shallowBoundary);
  const held = new Set<string>();
  for (const h of haves) {
    const r = resolveWant(store, h);
    const start = r.commit ?? (r.tag ?? h);
    if (r.tag) held.add(r.tag);
    const queue: string[] = [start];
    const seenCommits = new Set<string>();
    while (queue.length) {
      const c = queue.shift()!;
      if (seenCommits.has(c)) continue;
      seenCommits.add(c);
      held.add(c);
      const obj = store.getObject(c);
      if (!obj || obj.type !== 'commit') continue;
      const walk = (treeOid: string): void => {
        if (held.has(treeOid)) return;
        held.add(treeOid);
        const t = store.getObject(treeOid);
        if (!t || t.type !== 'tree') return;
        for (const e of parseTree(t.data)) {
          if (e.mode === '40000') walk(e.oid);
          else held.add(e.oid);
        }
      };
      walk(parseCommit(obj.data).tree);
      if (!boundary.has(c)) queue.push(...parseCommit(obj.data).parents);
    }
  }
  return { commits, tags, shallow, unshallow, held };
}

function collectPackObjects(store: Store, commits: string[], tags: string[], held: Set<string>): GitObject[] {
  const out: GitObject[] = [];
  const seen = new Set<string>();
  const add = (oid: string): void => {
    if (seen.has(oid) || held.has(oid)) return;
    const obj = store.getObject(oid);
    if (!obj) return;
    seen.add(oid);
    out.push(obj);
  };
  for (const t of tags) add(t);
  for (const c of commits) {
    add(c);
    const obj = store.getObject(c);
    if (!obj || obj.type !== 'commit') continue;
    const tree = parseCommit(obj.data).tree;
    const walk = (treeOid: string): void => {
      add(treeOid);
      const t = store.getObject(treeOid);
      if (!t || t.type !== 'tree') return;
      for (const e of parseTree(t.data)) add(e.oid);
      for (const e of parseTree(t.data)) if (e.mode === '40000') walk(e.oid);
    };
    walk(tree);
  }
  return out;
}

function packForFetch(store: Store, commits: string[], tags: string[], held: Set<string>): Buffer {
  return writePack(collectPackObjects(store, commits, tags, held));
}

function lsRefsResponse(store: Store, repo: Repo, argsIn: string[]): Buffer {
  const args = argsIn.map((a) => a.replace(/\n$/, ''));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const refs = listRefs(store, repo);
  const lines: Array<string | 'flush'> = [];
  if (refs.length) {
    for (const r of refs) {
      if (prefixes.length && !prefixes.some((p) => r.name.startsWith(p))) continue;
      let line = `${r.oid} ${r.name}`;
      if (r.name === 'HEAD' && symrefs && r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
      if (r.peeled && peel) line += ` peeled:${r.peeled}`;
      lines.push(line + '\n');
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

interface FetchArgs {
  wants: string[]; haves: string[]; shallow: string[];
  depth: number | null; deepenSince: number | null; deepenNot: string[];
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (t.startsWith('want ')) args.wants.push(t.slice(5).trim().split(' ')[0]);
    else if (t.startsWith('have ')) args.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) args.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) args.depth = parseInt(t.slice(7), 10);
    else if (t.startsWith('deepen-since ')) args.deepenSince = parseInt(t.slice(13), 10);
    else if (t.startsWith('deepen-not ')) args.deepenNot.push(t.slice(11).trim());
  }
  return args;
}

function v2FetchResponse(store: Store, repo: Repo, args: FetchArgs): Buffer {
  // A deepen request (haves present) deepens the shallow boundary; a plain
  // depth request limits the fetch to that many generations from the wants.
  const plan = planFetch(store, repo, args.wants, args.haves, args.haves.length ? null : args.depth, args.haves.length ? args.depth : null, args.shallow);
  const pack = packForFetch(store, plan.commits, plan.tags, plan.held);
  const parts: Buffer[] = [];
  const sec = (name: string, lines: string[]): void => {
    if (!lines.length) return;
    parts.push(pktLine(name + '\n'));
    for (const l of lines) parts.push(pktLine(l));
    parts.push(pktFlush());
  };
  const ackLines: string[] = [];
  if (args.haves.length) {
    const ok = args.haves.every((h) => plan.commits.length >= 0 && store.isAncestor(h, args.wants[0] ?? h));
    if (ok) { ackLines.push(`ACK ${args.haves[0]}\n`); ackLines.push('ready\n'); }
    else ackLines.push('NAK\n');
  } else {
    ackLines.push('NAK\n');
  }
  sec('acknowledgments', ackLines);
  sec('shallow-info', [
    ...plan.shallow.map((s) => `shallow ${s}\n`),
    ...plan.unshallow.map((s) => `unshallow ${s}\n`),
  ]);
  const wanted: string[] = [];
  for (const w of args.wants) {
    for (const r of listRefs(store, repo)) {
      if (r.oid === w) wanted.push(`${w} ${r.name}\n`);
    }
  }
  sec('wanted-refs', wanted);
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(1, pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, repo, args.wants, args.haves, args.haves.length ? null : args.depth, args.haves.length ? args.depth : null, args.shallow);
  const pack = packForFetch(store, plan.commits, plan.tags, plan.held);
  const parts: Buffer[] = [];
  if (args.haves.length) {
    const ok = args.haves.every((h) => store.isAncestor(h, args.wants[0] ?? h));
    parts.push(pktLine(ok ? `ACK ${args.haves[0]}\n` : 'NAK\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sidebandWrap(1, pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface PushCommand { oldOid: string; newOid: string; ref: string }

export function handleGit(
  store: Store, repo: Repo | undefined,
  method: string, subpath: string, query: URLSearchParams,
  headers: Record<string, string | undefined>, body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const service = query.get('service') ?? '';
  if (method === 'GET' && subpath === '/info/refs') {
    if (!repo) return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
    if (service === 'git-upload-pack') {
      const v2 = (headers['git-protocol'] ?? '') === 'version=2';
      if (v2) return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(store, repo, 'git-upload-pack') };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(store, repo, 'git-receive-pack') };
    }
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  }
  if (!repo) return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  if (method === 'POST' && subpath === '/git-upload-pack') {
    const v2 = (headers['git-protocol'] ?? '') === 'version=2';
    const packets = decodePktLines(body);
    const lines: string[] = [];
    let command = '';
    let inArgs = false;
    for (const p of packets) {
      if (p.kind === 'delim') { inArgs = true; continue; }
      if (p.kind !== 'data') continue;
      const text = p.payload.toString('utf8');
      if (!inArgs && text.startsWith('command=')) { command = text.slice(8).replace(/\n$/, ''); continue; }
      lines.push(text);
    }
    if (v2 && command === 'ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(store, repo, lines) };
    }
    if (command === 'fetch' || !v2) {
      const args = parseFetchArgs(lines);
      if (v2) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(store, repo, args) };
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(store, repo, args) };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: pktFlush() };
  }
  if (method === 'POST' && subpath === '/git-receive-pack') {
    return handleReceivePack(store, repo, body);
  }
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
}

function handleReceivePack(
  store: Store, repo: Repo, body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const commands: PushCommand[] = [];
  let caps = '';
  let packOffset = 0;
  // Parse pkt-lines until the first flush; the pack follows raw.
  let i = 0;
  let sawFlush = false;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { i += 4; sawFlush = true; break; }
    if (len < 4 || i + len > body.length) break;
    const payload = body.subarray(i + 4, i + len).toString('utf8');
    const nul = payload.indexOf('\0');
    let line = payload;
    if (nul >= 0 && commands.length === 0) { caps = payload.slice(nul + 1); line = payload.slice(0, nul); }
    const m = line.replace(/\n$/, '').match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    i += len;
  }
  packOffset = i;
  void sawFlush;
  const sideband = caps.includes('side-band-64k');
  const report = (unpackOk: boolean, unpackDetail: string, refs: Array<{ ref: string; ok: boolean; reason: string }>): Buffer => {
    const inner: Array<string | 'flush'> = [`unpack ${unpackDetail}\n`];
    for (const r of refs) inner.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
    inner.push('flush');
    const innerBuf = encodePktLines(inner);
    if (sideband) {
      const parts: Buffer[] = [];
      for (const line of [`unpack ${unpackDetail}\n`, ...refs.map((r) => r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`)]) {
        parts.push(sidebandWrap(1, pktLine(line)));
      }
      parts.push(pktFlush());
      return Buffer.concat(parts);
    }
    return innerBuf;
  };
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    const packBytes = body.subarray(packOffset);
    if (!packBytes.length) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const check = verifyPackChecksum(packBytes);
        if (!check.ok) throw new Error('pack checksum mismatch');
        const read = readPack(packBytes, (oid) => store.getObject(oid));
        for (const [oid, obj] of read.objects) {
          if (!store.objects.has(oid)) store.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message.slice(0, 80) : 'unpacker error';
      }
    }
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current !== undefined) {
        repo.refs.delete(cmd.ref);
        repo.snapshots.delete(cmd.ref);
      }
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    const obj = store.getObject(cmd.newOid);
    if (!obj) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      if (cmd.ref.startsWith('refs/heads/') && obj.type === 'commit') {
        repo.snapshots.set(cmd.ref, store.filesAtCommit(cmd.newOid));
      }
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!store.isAncestor(cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    if (cmd.ref.startsWith('refs/heads/') && obj.type === 'commit') {
      repo.snapshots.set(cmd.ref, store.filesAtCommit(cmd.newOid));
    }
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  void createHash;
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: report(unpackOk, unpackDetail, results),
  };
}
