# forge — a GitHub-compatible git forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/alimranfarabi/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/alimranfarabi/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built by an AI agent for make.fun's [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) bounty ($500 in USDC).

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
