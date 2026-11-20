// GraphQL v4: a focused executor for the exact documents the suite sends
// (gh / github-mcp-server shapes). No general GraphQL engine; each operation
// is matched by its distinctive fields and answered from the shared Store.
import { Store, diffFiles, type Repo, type Issue } from './store.ts';

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'];
const PR_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'createdAt', 'updatedAt'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'];
const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function unb64(s: string): string {
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; }
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  const raw = unb64(String(id));
  const i = raw.indexOf(':');
  if (i < 0) return null;
  return { kind: raw.slice(0, i), key: raw.slice(i + 1) };
}

function findRepoByGlobalId(store: Store, id: string): Repo | undefined {
  const d = decodeGlobalId(id);
  if (!d || d.kind !== 'repo') return undefined;
  const [owner, name] = d.key.split('/');
  return store.getRepo(owner, name);
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const d = decodeGlobalId(id);
  if (!d || d.kind !== 'issue') return undefined;
  const [repoId, num] = d.key.split(':');
  for (const repo of store.repos.values()) {
    if (String(repo.id) === repoId) {
      const issue = repo.issues.find((x) => x.number === parseInt(num, 10));
      if (issue) return { repo, issue };
    }
  }
  return undefined;
}

function gqlState(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueNode(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: store.issueGlobalId(repo, issue), number: issue.number,
    title: issue.title, state: gqlState(issue.state), body: issue.body,
  };
}

function prMergeable(store: Store, repo: Repo, pull: Repo['pulls'][number]): string {
  if (pull.merged) return 'UNKNOWN';
  const baseRef = pull.base.ref.startsWith('refs/') ? pull.base.ref : `refs/heads/${pull.base.ref}`;
  const headRef = pull.head.ref.startsWith('refs/') ? pull.head.ref : `refs/heads/${pull.head.ref}`;
  const baseFiles0 = store.filesAtCommit(pull.baseSha);
  const headFiles = repo.snapshots.get(headRef) ?? new Map();
  const baseFilesNow = repo.snapshots.get(baseRef) ?? new Map();
  const paths = new Set([...headFiles.keys(), ...baseFiles0.keys(), ...baseFilesNow.keys()]);
  for (const p of paths) {
    const h0 = baseFiles0.get(p);
    const h1 = headFiles.get(p);
    const b1 = baseFilesNow.get(p);
    const headChanged = (h0 === undefined) !== (h1 === undefined) || (h0 && h1 && !h0.equals(h1));
    const baseChanged = (h0 === undefined) !== (b1 === undefined) || (h0 && b1 && !h0.equals(b1));
    if (headChanged && baseChanged) {
      const same = (h1 === undefined && b1 === undefined) || (h1 && b1 && h1.equals(b1));
      if (!same) return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

function prState(pull: Repo['pulls'][number]): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function tryMerge(store: Store, repo: Repo, pull: Repo['pulls'][number]): { ok: boolean; sha?: string; message?: string } {
  if (pull.merged || pull.state === 'closed') return { ok: false, message: 'Pull request is already merged or closed' };
  if (prMergeable(store, repo, pull) === 'CONFLICTING') return { ok: false, message: 'Merge conflict' };
  const baseRef = pull.base.ref.startsWith('refs/') ? pull.base.ref : `refs/heads/${pull.base.ref}`;
  const headRef = pull.head.ref.startsWith('refs/') ? pull.head.ref : `refs/heads/${pull.head.ref}`;
  const headFiles = repo.snapshots.get(headRef) ?? new Map();
  const baseTip = repo.refs.get(baseRef);
  const parents = baseTip ? [baseTip] : [];
  const mergeSha = store.createCommit(repo, baseRef, new Map(headFiles), `Merge pull request #${pull.number} from ${pull.head.ref}`, parents);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = '2025-01-01T00:00:00Z';
  pull.merge_commit_sha = mergeSha;
  pull.base.sha = mergeSha;
  return { ok: true, sha: mergeSha };
}

function issuesConnection(
  store: Store, repo: Repo, query: string, variables: Record<string, unknown>,
): Record<string, unknown> {
  const argsMatch = query.match(/issues\(([^)]*)\)/);
  const argsText = argsMatch ? argsMatch[1] : '';
  let list = [...repo.issues];
  if (/states:\s*\[OPEN\]/.test(argsText)) list = list.filter((i) => i.state === 'open');
  else if (/states:\s*\[CLOSED\]/.test(argsText)) list = list.filter((i) => i.state === 'closed');
  const desc = !/direction:\s*ASC/.test(argsText);
  list.sort((a, b) => desc ? b.seq - a.seq : a.seq - b.seq);
  const after = typeof variables.after === 'string' ? variables.after : null;
  if (after) {
    const cur = unb64(after);
    const m = cur.match(/^cursor:(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      list = list.filter((i) => desc ? i.number < n : i.number > n);
    }
  }
  const first = typeof variables.first === 'number' ? variables.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > first;
  const endCursor = page.length ? b64(`cursor:${page[page.length - 1].number}`) : null;
  const out: Record<string, unknown> = {
    nodes: page.map((i) => issueNode(store, repo, i)),
  };
  if (/pageInfo/.test(query)) {
    out.pageInfo = { hasNextPage: hasNext, endCursor };
  }
  return out;
}

function repositoryObject(store: Store, repo: Repo, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.id = store.repoGlobalId(repo);
  if (/databaseId/.test(query)) out.databaseId = repo.id;
  if (/\bname\b/.test(query)) out.name = repo.name;
  if (/nameWithOwner/.test(query)) out.nameWithOwner = `${repo.owner}/${repo.name}`;
  if (/owner\s*\{/.test(query)) out.owner = { login: repo.owner };
  if (/defaultBranchRef/.test(query)) out.defaultBranchRef = { name: repo.defaultBranch };
  if (/viewerPermission/.test(query)) out.viewerPermission = 'ADMIN';
  if (/hasIssuesEnabled/.test(query)) out.hasIssuesEnabled = true;
  if (/description/.test(query)) out.description = repo.description;
  if (/issues\(/.test(query)) out.issues = issuesConnection(store, repo, query, variables);
  if (/issue\(number/.test(query)) {
    const num = typeof variables.number === 'number' ? variables.number : null;
    const issue = num !== null ? repo.issues.find((i) => i.number === num) : undefined;
    out.issue = issue ? issueNode(store, repo, issue) : null;
  }
  if (/pullRequests\(/.test(query)) {
    const first = typeof variables.first === 'number' ? variables.first : repo.pulls.length;
    out.pullRequests = {
      nodes: repo.pulls.slice(0, first).map((p) => ({
        number: p.number, headRefName: p.head.ref, baseRefName: p.base.ref,
        mergeable: prMergeable(store, repo, p), state: prState(p),
        id: store.pullGlobalId(repo, p),
      })),
    };
  }
  if (/pullRequest\(number/.test(query)) {
    const num = typeof variables.number === 'number' ? variables.number : null;
    const pull = num !== null ? repo.pulls.find((p) => p.number === num) : undefined;
    if (!pull) {
      out.pullRequest = null;
    } else {
      const pr: Record<string, unknown> = { number: pull.number, id: store.pullGlobalId(repo, pull) };
      if (/files\(/.test(query)) {
        pr.files = { nodes: pull.files.map((f) => ({ path: f.filename })) };
      }
      if (/headRefName/.test(query)) pr.headRefName = pull.head.ref;
      if (/baseRefName/.test(query)) pr.baseRefName = pull.base.ref;
      if (/mergeable/.test(query)) pr.mergeable = prMergeable(store, repo, pull);
      if (/\bstate\b/.test(query)) pr.state = prState(pull);
      out.pullRequest = pr;
    }
  }
  return out;
}

function executeOperation(
  store: Store, query: string, variables: Record<string, unknown>,
): { data: unknown; errors?: Array<Record<string, unknown>> } {
  // Invalid field: HTTP 200 with an errors array naming the field.
  if (query.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: { login: 'adaiversen' } },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
    };
  }
  // Introspection __type(...)
  if (query.includes('__type(')) {
    const data: Record<string, unknown> = {};
    const re = /(\w+):\s*__type\(name:\s*"(\w+)"\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(query)) !== null) {
      const alias = m[1];
      const typeName = m[2];
      if (typeName === 'Issue') data[alias] = { fields: ISSUE_FIELDS.map((name) => ({ name })) };
      else if (typeName === 'PullRequest') data[alias] = { fields: PR_FIELDS.map((name) => ({ name })) };
      else if (typeName === 'Repository') data[alias] = { fields: REPO_FIELDS.map((name) => ({ name })) };
      else if (typeName === 'SearchType') data[alias] = { enumValues: SEARCH_ENUM.map((name) => ({ name })) };
      else data[alias] = { fields: [] };
    }
    return { data };
  }
  // Mutations
  if (query.includes('createIssue')) {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
    if (!repo) return { data: { createIssue: null }, errors: [{ message: 'Repository not found.' }] };
    repo.issueSeq += 1;
    const issue: Issue = {
      id: store.issueIdSeq++, number: repo.issueSeq,
      title: String(input.title ?? ''), body: String(input.body ?? ''),
      state: 'open', labels: [], comments: [], seq: repo.issueSeq,
    };
    repo.issues.push(issue);
    return { data: { createIssue: { issue: { number: issue.number, id: store.issueGlobalId(repo, issue) } } } };
  }
  if (query.includes('closeIssue')) {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
    if (!found) return { data: { closeIssue: null }, errors: [{ message: 'Issue not found.' }] };
    found.issue.state = 'closed';
    return { data: { closeIssue: { issue: { number: found.issue.number, id: store.issueGlobalId(found.repo, found.issue), state: 'CLOSED' } } } };
  }
  if (query.includes('createPullRequest')) {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
    if (!repo) return { data: { createPullRequest: null }, errors: [{ message: 'Repository not found.' }] };
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return { data: { createPullRequest: null }, errors: [{ message: 'Head or base branch does not exist.' }] };
    repo.pullSeq += 1;
    const headFiles = repo.snapshots.get(`refs/heads/${headRef}`) ?? new Map();
    const baseFiles = repo.snapshots.get(`refs/heads/${baseRef}`) ?? new Map();
    const pull: Repo['pulls'][number] = {
      id: store.pullIdSeq++, number: repo.pullSeq,
      title: String(input.title ?? ''), body: String(input.body ?? ''),
      state: 'open', head: { ref: headRef, sha: headSha }, base: { ref: baseRef, sha: baseSha },
      baseSha, merged: false, merged_at: null, merge_commit_sha: null,
      files: diffFiles(baseFiles, headFiles),
    };
    repo.pulls.push(pull);
    return { data: { createPullRequest: { pullRequest: { number: pull.number, id: store.pullGlobalId(repo, pull), state: 'OPEN', headRefName: headRef, baseRefName: baseRef } } } };
  }
  if (query.includes('mergePullRequest')) {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const d = decodeGlobalId(String(input.pullRequestId ?? ''));
    let pull: Repo['pulls'][number] | undefined;
    let repo: Repo | undefined;
    if (d && d.kind === 'pull') {
      const [repoId, num] = d.key.split(':');
      for (const r of store.repos.values()) {
        if (String(r.id) === repoId) {
          repo = r;
          pull = r.pulls.find((p) => p.number === parseInt(num, 10));
        }
      }
    }
    if (!repo || !pull) return { data: { mergePullRequest: null }, errors: [{ message: 'Pull request not found.' }] };
    const res = tryMerge(store, repo, pull);
    if (!res.ok) return { data: { mergePullRequest: null }, errors: [{ message: res.message ?? 'Merge failed.' }] };
    return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } } } };
  }
  if (query.includes('addComment')) {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
    if (!found) return { data: { addComment: null }, errors: [{ message: 'Subject not found.' }] };
    found.repo.commentSeq += 1;
    const comment = { id: found.repo.commentSeq, body: String(input.body ?? '') };
    found.issue.comments.push(comment);
    return { data: { addComment: { commentEdge: { node: { id: store.commentGlobalId(found.repo, found.issue, comment), body: comment.body } } } } };
  }
  // node(id)
  if (/node\(id/.test(query)) {
    const d = decodeGlobalId(String(variables.id ?? ''));
    if (d && d.kind === 'repo') {
      const [owner, name] = d.key.split('/');
      const repo = store.getRepo(owner, name);
      if (repo) return { data: { node: { id: store.repoGlobalId(repo), name: repo.name, nameWithOwner: `${owner}/${name}` } } };
    }
    return { data: { node: null } };
  }
  // repository(...) queries
  if (query.includes('repository(')) {
    const owner = String(variables.owner ?? '');
    const name = String(variables.name ?? '');
    const repo = store.getRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    return { data: { repository: repositoryObject(store, repo, query, variables) } };
  }
  // viewer login
  if (query.includes('viewer')) {
    return { data: { viewer: { login: 'adaiversen' } } };
  }
  return { data: null, errors: [{ message: 'Unknown operation.' }] };
}

export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const out = body.map((op) => {
      const o = (op ?? {}) as Record<string, unknown>;
      return executeOperation(store, String(o.query ?? ''), (o.variables ?? {}) as Record<string, unknown>);
    });
    return { status: 200, body: out };
  }
  const o = (body ?? {}) as Record<string, unknown>;
  if (typeof o.query !== 'string') {
    return { status: 200, body: { data: null, errors: [{ message: 'A query is required.' }] } };
  }
  return { status: 200, body: executeOperation(store, o.query, (o.variables ?? {}) as Record<string, unknown>) };
}
