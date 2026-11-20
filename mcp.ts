// MCP over Streamable HTTP: modern server/discover (2026-07-28) plus the
// legacy initialize handshake, tools/list and tools/call for the six tools
// the suite uses. Tools act on the same Store as REST.
import { Store, diffFiles, type Repo } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'forge-session-1';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' }, full_name: { type: 'string' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

const ALIASES: Record<string, string> = {
  createrepo: 'create_repo', createrepository: 'create_repo', repocreate: 'create_repo',
  reposcreate: 'create_repo', repositorycreate: 'create_repo',
  getrepo: 'get_repo', getrepository: 'get_repo', repoget: 'get_repo',
  reposget: 'get_repo', repositoryget: 'get_repo',
  createissue: 'create_issue', issuecreate: 'create_issue', issuescreate: 'create_issue',
  listissues: 'list_issues', issueslist: 'list_issues', issuelist: 'list_issues',
  createpullrequest: 'create_pull_request', pullrequestcreate: 'create_pull_request',
  pullscreate: 'create_pull_request', createpr: 'create_pull_request', prcreate: 'create_pull_request',
  mergepullrequest: 'merge_pull_request', pullrequestmerge: 'merge_pull_request',
  pullsmerge: 'merge_pull_request', mergepr: 'merge_pull_request', prmerge: 'merge_pull_request',
};

function normalizeName(name: string): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalTool(name: string): string | null {
  const n = normalizeName(name);
  if (ALIASES[n]) return ALIASES[n];
  for (const t of TOOLS) {
    const tn = normalizeName(t.name);
    if (n === tn || n.endsWith(tn)) return t.name;
  }
  return null;
}

const SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
  head: ['head', 'head_ref', 'head_branch', 'head_ref_name', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'base_ref_name', 'target', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
};

function pick(args: Record<string, unknown>, key: string): unknown {
  for (const alt of SYNONYMS[key] ?? [key]) {
    if (args[alt] !== undefined && args[alt] !== null && args[alt] !== '') return args[alt];
  }
  return undefined;
}

function splitFullName(args: Record<string, unknown>): void {
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  if (full.includes('/')) {
    const [o, r] = full.split('/');
    if (args.owner === undefined) args.owner = o;
    if (args.repo === undefined) args.repo = r;
  }
}

function textResult(obj: unknown): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function mergePull(store: Store, repo: Repo, pull: Repo['pulls'][number]): { ok: boolean; sha?: string; message?: string } {
  if (pull.merged || pull.state === 'closed') return { ok: false, message: 'Pull request is already merged or closed' };
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
      if (!same) return { ok: false, message: 'Merge conflict' };
    }
  }
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

function callTool(store: Store, owner: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  splitFullName(args);
  if (name === 'create_repo') {
    const repoName = pick(args, 'name');
    if (typeof repoName !== 'string' || !repoName) return errorResult('missing argument: name');
    if (store.getRepo(owner, repoName)) return errorResult(`repository already exists: ${repoName}`);
    const repo = store.createRepo(owner, repoName, pick(args, 'private') === true, typeof pick(args, 'description') === 'string' ? String(pick(args, 'description')) : '');
    return textResult({ id: repo.id, name: repo.name, full_name: `${owner}/${repoName}`, owner: { login: owner }, private: repo.private, default_branch: repo.defaultBranch });
  }
  const repoName = pick(args, 'repo');
  const repoOwner = pick(args, 'owner');
  if (typeof repoName !== 'string' || !repoName) return errorResult('missing argument: repo');
  const repo = store.getRepo(typeof repoOwner === 'string' ? repoOwner : owner, repoName);
  if (name === 'get_repo') {
    if (!repo) return errorResult(`repository not found: ${repoOwner}/${repoName}`);
    return textResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch, description: repo.description });
  }
  if (!repo) return errorResult(`repository not found: ${repoOwner}/${repoName}`);
  if (name === 'create_issue') {
    const title = pick(args, 'title');
    if (typeof title !== 'string' || !title) return errorResult('missing argument: title');
    repo.issueSeq += 1;
    const issue = {
      id: store.issueIdSeq++, number: repo.issueSeq,
      title, body: typeof pick(args, 'body') === 'string' ? String(pick(args, 'body')) : '',
      state: 'open', labels: [] as string[], comments: [] as Array<{ id: number; body: string }>, seq: repo.issueSeq,
    };
    repo.issues.push(issue);
    return textResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: 'open', full_name: `${repo.owner}/${repo.name}` });
  }
  if (name === 'list_issues') {
    let list = [...repo.issues];
    const state = pick(args, 'state');
    if (typeof state === 'string' && state) {
      const s = state.toLowerCase();
      list = list.filter((i) => i.state === s);
    }
    return textResult({ issues: list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state })) });
  }
  if (name === 'create_pull_request') {
    const title = pick(args, 'title');
    const head = pick(args, 'head');
    const base = pick(args, 'base');
    if (typeof title !== 'string' || !title) return errorResult('missing argument: title');
    if (typeof head !== 'string' || !head) return errorResult('missing argument: head');
    if (typeof base !== 'string' || !base) return errorResult('missing argument: base');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return errorResult('head or base branch does not exist');
    repo.pullSeq += 1;
    const headFiles = repo.snapshots.get(`refs/heads/${head}`) ?? new Map();
    const baseFiles = repo.snapshots.get(`refs/heads/${base}`) ?? new Map();
    const pull: Repo['pulls'][number] = {
      id: store.pullIdSeq++, number: repo.pullSeq,
      title, body: typeof pick(args, 'body') === 'string' ? String(pick(args, 'body')) : '',
      state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
      baseSha, merged: false, merged_at: null, merge_commit_sha: null,
      files: diffFiles(baseFiles, headFiles),
    };
    repo.pulls.push(pull);
    return textResult({ id: pull.id, number: pull.number, title: pull.title, state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } });
  }
  if (name === 'merge_pull_request') {
    const numRaw = pick(args, 'pull_number');
    const num = typeof numRaw === 'number' ? numRaw : parseInt(String(numRaw ?? ''), 10);
    if (!num) return errorResult('missing argument: pull_number');
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return errorResult(`pull request not found: ${num}`);
    const res = mergePull(store, repo, pull);
    if (!res.ok) return errorResult(res.message ?? 'Merge failed');
    return textResult({ merged: true, sha: res.sha, number: pull.number });
  }
  return errorResult(`unknown tool: ${name}`);
}

export interface McpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function handleMcp(
  store: Store, owner: string, method: string, rawBody: Buffer,
): McpResult {
  if (method === 'DELETE') return { status: 204, body: null };
  if (method !== 'POST') return { status: 405, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } } };
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    msg = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = msg.id ?? null;
  const rpcMethod = String(msg.method ?? '');
  // Notifications carry no id and get no response body.
  if (rpcMethod.startsWith('notifications/') || msg.id === undefined) {
    return { status: 202, body: null };
  }
  const okResult = (result: unknown, extraHeaders?: Record<string, string>): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result },
    headers: extraHeaders,
  });
  const rpcError = (code: number, message: string, data?: unknown): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
  });
  if (rpcMethod === 'server/discover') {
    return okResult({
      supportedVersions: SUPPORTED,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (rpcMethod === 'initialize') {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const requested = String(params.protocolVersion ?? '');
    const chosen = SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
    if (requested && !SUPPORTED.includes(requested)) {
      return rpcError(-32022, `Unsupported protocol version: ${requested}`, { supported: SUPPORTED });
    }
    return okResult({
      protocolVersion: chosen,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    }, { 'mcp-session-id': SESSION_ID });
  }
  if (rpcMethod === 'ping') return okResult({});
  if (rpcMethod === 'tools/list') {
    return okResult({ tools: TOOLS });
  }
  if (rpcMethod === 'tools/call') {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const toolName = String(params.name ?? '');
    const canonical = canonicalTool(toolName);
    if (!canonical) return rpcError(-32602, `Unknown tool: ${toolName}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = callTool(store, owner, canonical, args);
    return okResult(result);
  }
  return rpcError(-32601, `Method not found: ${rpcMethod}`);
}
