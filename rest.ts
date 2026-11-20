// REST v3 handlers: repos, branches, commits, contents, issues, comments,
// labels and pull requests. All state lives in the Store; ids are sequential.
import { Store, VIEWER_LOGIN, VIEWER_ID, diffFiles, type Repo, type Issue } from './store.ts';
import { ZERO_OID } from './gitproto.ts';

export interface RestCtx {
  store: Store;
  owner: string; // login the token names
  origin: string; // http://host:port of this server, for Link headers
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private, description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
    has_issues: true, has_projects: false, has_wiki: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown> {
  const headRef = pull.head.ref.startsWith('refs/') ? pull.head.ref : `refs/heads/${pull.head.ref}`;
  const baseRef = pull.base.ref.startsWith('refs/') ? pull.base.ref : `refs/heads/${pull.base.ref}`;
  return {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: repo.refs.get(headRef) ?? pull.head.sha },
    base: { ref: pull.base.ref, sha: repo.refs.get(baseRef) ?? pull.base.sha },
    merged: pull.merged, merged_at: pull.merged_at, merge_commit_sha: pull.merge_commit_sha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function contentsBranch(query: URLSearchParams, body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.branch === 'string' && b.branch ? b.branch
    : (query.get('branch') ?? query.get('ref') ?? 'main');
  return name.startsWith('refs/') ? name : `refs/heads/${name}`;
}

function refName(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '');
}

function findRepo(ctx: RestCtx, owner: string, name: string): Repo | undefined {
  if (owner !== ctx.owner) return undefined; // another owner's repo is 404, never 403
  return ctx.store.getRepo(owner, name);
}

export function handleRest(
  ctx: RestCtx, method: string, path: string,
  query: URLSearchParams, body: unknown,
): RestResult {
  const store = ctx.store;
  const seg = path.split('/').filter((s) => s.length > 0);

  // GET /api/v3/ and /api/v3/meta
  if (seg.length === 2 && method === 'GET') {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg.length === 3 && seg[2] === 'meta' && method === 'GET') {
    return ok(200, { installed_version: '1.0.0' });
  }
  if (seg.length === 3 && seg[2] === 'user' && method === 'GET') {
    return ok(200, { login: ctx.owner, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' });
  }

  // /api/v3/user/repos
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      const all = store.listRepos(ctx.owner);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const next = `${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const lastPage = Math.ceil(all.length / perPage);
        const last = `${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}`;
        const first = `${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=1`;
        headers.Link = `<${next}>; rel="next", <${last}>; rel="last", <${first}>; rel="first"`;
      }
      return ok(200, slice.map(repoJson), headers);
    }
    if (method === 'POST') {
      const b = (body ?? {}) as Record<string, unknown>;
      const name = String(b.name ?? '');
      if (!name) return err(422, 'name is required');
      if (store.getRepo(ctx.owner, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(ctx.owner, name, b.private === true, String(b.description ?? ''));
      return ok(201, repoJson(repo));
    }
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg.length >= 4 && seg[2] === 'repos') {
    const owner = seg[3];
    const name = seg[4];
    const repo = findRepo(ctx, owner, name);
    const rest = seg.slice(5);
    if (!repo) return err(404, 'Not Found');
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }
    const head = rest[0];
    // git/refs
    if (head === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const b = (body ?? {}) as Record<string, unknown>;
        const ref = String(b.ref ?? '');
        const sha = String(b.sha ?? '');
        if (!ref || !sha) return err(422, 'ref and sha are required');
        if (!store.getObject(sha)) return err(422, 'sha does not exist');
        repo.refs.set(ref, sha);
        if (ref.startsWith('refs/heads/')) {
          const obj = store.getObject(sha);
          if (obj && obj.type === 'commit') repo.snapshots.set(ref, store.filesAtCommit(sha));
        }
        return ok(201, { ref, object: { sha }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}` });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = 'refs/' + rest.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { ref, object: { sha } });
      }
      return err(404, 'Not Found');
    }
    // branches
    if (head === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const out: unknown[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
          if (ref.startsWith('refs/heads/')) out.push({ name: shortRef(ref), commit: { sha } });
        }
        return ok(200, out);
      }
      if (method === 'GET' && rest.length === 2) {
        const sha = repo.refs.get(refName(rest[1]));
        if (!sha) return err(404, 'Not Found');
        return ok(200, { name: rest[1], commit: { sha } });
      }
      return err(404, 'Not Found');
    }
    // commits
    if (head === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        const shaParam = query.get('sha');
        const tip = shaParam
          ? (repo.refs.get(refName(shaParam)) ?? (store.getObject(shaParam) ? shaParam : undefined))
          : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip || tip === ZERO_OID) return ok(200, []);
        const out: unknown[] = [];
        for (const oid of store.reachableCommits(tip)) {
          const obj = store.getObject(oid);
          if (!obj) continue;
          const info = parseCommitLocal(obj.data);
          out.push({ sha: oid, commit: { message: info.message, author: { name: 'ada iversen', email: 'adaiversen@example.invalid' }, committer: { name: 'ada iversen', email: 'adaiversen@example.invalid' } }, parents: info.parents.map((p) => ({ sha: p })) });
        }
        return ok(200, out);
      }
      if (method === 'GET' && rest.length === 2) {
        const obj = store.getObject(rest[1]);
        if (!obj || obj.type !== 'commit') return err(404, 'Not Found');
        const info = parseCommitLocal(obj.data);
        return ok(200, { sha: rest[1], commit: { message: info.message }, parents: info.parents.map((p) => ({ sha: p })) });
      }
      return err(404, 'Not Found');
    }
    // contents
    if (head === 'contents') {
      const rawPath = rest.slice(1).join('/');
      const path = decodeURIComponent(rawPath);
      // GET reads ?ref; PUT/DELETE take the branch from the body (GitHub's
      // API), falling back to ?branch or ?ref.
      const branch = (method === 'PUT' || method === 'DELETE')
        ? contentsBranch(query, body)
        : (query.get('ref') ? refName(query.get('ref')!) : `refs/heads/${repo.defaultBranch}`);
      if (method === 'GET') {
        const snap = repo.snapshots.get(branch);
        if (!snap) return err(404, 'Not Found');
        if (path === '') {
          return ok(200, dirListing(store, snap, ''));
        }
        const file = snap.get(path);
        if (file !== undefined) {
          const blobSha = store.putObject('blob', file);
          return ok(200, { type: 'file', encoding: 'base64', size: file.length, name: path.split('/').pop(), path, content: file.toString('base64'), sha: blobSha });
        }
        const prefix = path + '/';
        if ([...snap.keys()].some((k) => k.startsWith(prefix))) {
          return ok(200, dirListing(store, snap, path));
        }
        return err(404, 'Not Found');
      }
      if (method === 'PUT') {
        const b = (body ?? {}) as Record<string, unknown>;
        const contentB64 = String(b.content ?? '');
        let content: Buffer;
        try { content = Buffer.from(contentB64, 'base64'); } catch { return err(400, 'content must be base64'); }
        const files = new Map(repo.snapshots.get(branch) ?? []);
        const existed = files.has(path);
        if (existed) {
          const curSha = store.putObject('blob', files.get(path)!);
          if (typeof b.sha === 'string' && b.sha !== curSha) return err(409, 'sha does not match the current content');
        }
        files.set(path, content);
        const parents: string[] = [];
        const tip = repo.refs.get(branch);
        if (tip && tip !== ZERO_OID) parents.push(tip);
        const message = typeof b.message === 'string' ? b.message : existed ? `Update ${path}` : `Create ${path}`;
        const commitSha = store.createCommit(repo, branch, files, message, parents);
        const blobSha = store.putObject('blob', content);
        return ok(existed ? 200 : 201, {
          content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha },
        });
      }
      if (method === 'DELETE') {
        const b = (body ?? {}) as Record<string, unknown>;
        const files = new Map(repo.snapshots.get(branch) ?? []);
        if (!files.has(path)) return err(404, 'Not Found');
        files.delete(path);
        const parents: string[] = [];
        const tip = repo.refs.get(branch);
        if (tip && tip !== ZERO_OID) parents.push(tip);
        const message = typeof b.message === 'string' ? b.message : `Delete ${path}`;
        const commitSha = store.createCommit(repo, branch, files, message, parents);
        return ok(200, { commit: { sha: commitSha } });
      }
      return err(404, 'Not Found');
    }
    // labels
    if (head === 'labels') {
      if (method === 'GET') return ok(200, [...repo.labels.values()]);
      if (method === 'POST') {
        const b = (body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? '');
        if (!name) return err(422, 'name is required');
        const label = { name, color: String(b.color ?? 'ededed') };
        repo.labels.set(name, label);
        return ok(201, label);
      }
      return err(404, 'Not Found');
    }
    // issues
    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          const labels = Array.isArray(b.labels) ? b.labels.map((l) => typeof l === 'string' ? l : String((l as Record<string, unknown>).name ?? '')) : [];
          for (const l of labels) if (!repo.labels.has(l)) return err(422, `label does not exist: ${l}`);
          repo.issueSeq += 1;
          const issue: Issue = {
            id: store.issueIdSeq++, number: repo.issueSeq,
            title: String(b.title ?? ''), body: String(b.body ?? ''),
            state: 'open', labels, comments: [], seq: repo.issueSeq,
          };
          repo.issues.push(issue);
          return ok(201, issueJson(repo, issue));
        }
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = query.get('state');
          if (state && state !== 'all') list = list.filter((i) => i.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          }
          const perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
          const page = parseInt(query.get('page') ?? '1', 10) || 1;
          list = list.slice((page - 1) * perPage, page * perPage);
          return ok(200, list.map((i) => issueJson(repo, i)));
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const b = (body ?? {}) as Record<string, unknown>;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          return ok(200, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          repo.commentSeq += 1;
          const comment = { id: repo.commentSeq, body: String(b.body ?? '') };
          issue.comments.push(comment);
          return ok(201, { id: comment.id, body: comment.body });
        }
        if (method === 'GET') {
          return ok(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    // pulls
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          const headRef = typeof b.head === 'string' ? b.head : String((b.head as Record<string, unknown>)?.ref ?? '');
          const baseRef = typeof b.base === 'string' ? b.base : String((b.base as Record<string, unknown>)?.ref ?? '');
          const headSha = repo.refs.get(refName(headRef));
          const baseSha = repo.refs.get(refName(baseRef));
          if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
          repo.pullSeq += 1;
          const headFiles = repo.snapshots.get(refName(headRef)) ?? new Map();
          const baseFiles = repo.snapshots.get(refName(baseRef)) ?? new Map();
          const pull: Repo['pulls'][number] = {
            id: store.pullIdSeq++, number: repo.pullSeq,
            title: String(b.title ?? ''), body: String(b.body ?? ''),
            state: 'open',
            head: { ref: headRef, sha: headSha }, base: { ref: baseRef, sha: baseSha },
            baseSha, merged: false, merged_at: null, merge_commit_sha: null,
            files: diffFiles(baseFiles, headFiles),
          };
          repo.pulls.push(pull);
          return ok(201, pullJson(repo, pull));
        }
        if (method === 'GET') {
          const state = query.get('state');
          let list = [...repo.pulls];
          if (!state || state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          return ok(200, list.map((p) => pullJson(repo, p)));
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(rest[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pull) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullJson(repo, pull));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pull.files);
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return err(404, 'Not Found');
        if (method !== 'PUT') return err(404, 'Not Found');
        if (pull.merged || pull.state === 'closed') return err(405, 'Pull request is already merged or closed');
        const baseRef = refName(pull.base.ref);
        const headRef = refName(pull.head.ref);
        const baseFiles0 = store.filesAtCommit(pull.baseSha);
        const headFiles = repo.snapshots.get(headRef) ?? new Map();
        const baseFilesNow = repo.snapshots.get(baseRef) ?? new Map();
        let conflict = false;
        const paths = new Set([...headFiles.keys(), ...baseFiles0.keys(), ...baseFilesNow.keys()]);
        for (const p of paths) {
          const h0 = baseFiles0.get(p);
          const h1 = headFiles.get(p);
          const b1 = baseFilesNow.get(p);
          const headChanged = (h0 === undefined) !== (h1 === undefined) || (h0 && h1 && !h0.equals(h1));
          const baseChanged = (h0 === undefined) !== (b1 === undefined) || (h0 && b1 && !h0.equals(b1));
          if (headChanged && baseChanged) {
            const same = (h1 === undefined && b1 === undefined) || (h1 && b1 && h1.equals(b1));
            if (!same) { conflict = true; break; }
          }
        }
        if (conflict) return err(405, 'Merge conflict');
        const baseTip = repo.refs.get(baseRef);
        const parents = baseTip && baseTip !== ZERO_OID ? [baseTip] : [];
        const mergeSha = store.createCommit(repo, baseRef, new Map(headFiles), `Merge pull request #${pull.number} from ${pull.head.ref}`, parents);
        pull.state = 'closed';
        pull.merged = true;
        pull.merged_at = '2025-01-01T00:00:00Z';
        pull.merge_commit_sha = mergeSha;
        pull.base.sha = mergeSha;
        return ok(200, { merged: true, sha: mergeSha, message: `Pull request #${pull.number} merged` });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function parseCommitLocal(data: Buffer): { message: string; parents: string[] } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { message, parents };
}

function dirListing(store: Store, snap: Map<string, Buffer>, dir: string): unknown[] {
  const prefix = dir === '' ? '' : dir + '/';
  const seen = new Map<string, { type: string; name: string; path: string; sha: string }>();
  for (const key of snap.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const blobSha = store.putObject('blob', snap.get(key)!);
      seen.set(rest, { type: 'file', name: rest, path: prefix + rest, sha: blobSha });
    } else {
      const d = rest.slice(0, slash);
      if (!seen.has(d)) {
        seen.set(d, { type: 'dir', name: d, path: prefix + d, sha: ZERO_OID });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name < b.name ? -1 : 1);
}
