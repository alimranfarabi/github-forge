# forge — a GitHub-compatible git forge in one Node process

A standalone forge that serves git smart HTTP (protocol v2 upload-pack,
v0 receive-pack), the REST v3 API, GraphQL v4 and MCP from its own
in-memory store. No UI, no outside service, no git binary: only the Node
standard library.

## Run it

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must name the trial env to register with, and
`MAKEFUN_SHOP_TOKEN` is the bearer token the suite presents (the token's
owner is the viewer `adaiversen`).

## Layout

- `main.ts` — the entry lifecycle: bind an ephemeral port, register it with
  the env, poll `/done`, exit 0.
- `app.ts` — the HTTP server: auth, JSON-everywhere replies, routing.
- `store.ts` — the in-memory store: git objects, refs, repos, issues, PRs.
- `gitproto.ts` — pkt-line framing, packfile read/write, delta application.
- `git.ts` — git smart HTTP: advertisements, ls-refs, fetch (v2/v0),
  receive-pack with strict fast-forward rules.
- `rest.ts` — REST v3: repos, branches, commits, contents, labels, issues,
  comments, pull requests and squash merges.
- `graphql.ts` — GraphQL v4 for the documents `gh` and `github-mcp-server`
  send, including introspection, batching and cursor pagination.
- `mcp.ts` — MCP over Streamable HTTP: `server/discover`, the legacy
  `initialize` handshake, `tools/list` and `tools/call`.
