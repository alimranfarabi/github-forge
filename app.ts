// The forge's HTTP server: one process, stdlib only. Routes git smart HTTP,
// REST v3, GraphQL v4 and MCP onto a single in-memory Store, with the
// bearer-token auth and the JSON-everywhere wire rules the suite checks.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function requestId(counter: number): string {
  return `req-${counter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, reqNo: number, extra: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(reqNo),
    ...(body === null ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, reqNo: number): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(reqNo),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let reqCounter = 0;

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqNo = ++reqCounter;
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, reqNo);
        return;
      }

      // Auth: every surface except /healthz needs the trial bearer token.
      // When the env carries no token (local runs without one), accept any.
      if (expectedToken !== '') {
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${expectedToken}`) {
          sendJson(res, 401, { message: 'Unauthorized' }, reqNo);
          return;
        }
      }

      const body = await readBody(req);

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
      if (gitMatch) {
        const owner = gitMatch[1];
        const repoName = gitMatch[2];
        const subpath = gitMatch[3] ?? '/';
        if (owner !== VIEWER_LOGIN) {
          sendJson(res, 404, { message: 'Not Found' }, reqNo);
          return;
        }
        const repo = store.getRepo(owner, repoName);
        const headers: Record<string, string | undefined> = {
          'git-protocol': req.headers['git-protocol'],
        };
        const result = handleGit(store, repo, method, subpath, url.searchParams, headers, body);
        if (result.contentType.startsWith('application/json')) {
          sendRaw(res, result.status, result.contentType, result.body, reqNo);
        } else {
          sendRaw(res, result.status, result.contentType, result.body, reqNo);
        }
        return;
      }

      // MCP: raw body (it answers parse errors itself).
      if (path === '/mcp') {
        const result = handleMcp(store, VIEWER_LOGIN, method, body);
        if (result.status === 204 || result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': requestId(reqNo), ...(result.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, reqNo, result.headers ?? {});
        return;
      }

      // GraphQL
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' }, reqNo);
          return;
        }
        let parsed: unknown = null;
        try {
          parsed = body.length ? JSON.parse(body.toString('utf8')) : null;
        } catch {
          sendJson(res, 400, { message: 'Malformed JSON body' }, reqNo);
          return;
        }
        const result = handleGraphQL(store, parsed);
        sendJson(res, result.status, result.body, reqNo);
        return;
      }

      // REST v3
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        let parsed: unknown = null;
        if (body.length) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON body' }, reqNo);
            return;
          }
        }
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        const result = handleRest({ store, owner: VIEWER_LOGIN, origin }, method, path, url.searchParams, parsed);
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': requestId(reqNo) });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, reqNo, result.headers ?? {});
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, reqNo);
    } catch (err) {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' }, reqNo);
      } catch {
        // The socket is gone; nothing left to do.
      }
    }
  });
}
