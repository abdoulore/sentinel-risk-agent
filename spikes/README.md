# spikes/ — experimental, unused

Nothing in this directory is imported by the Sentinel runtime. It is excluded
from `tsconfig.json`, so `@/…` path aliases do not resolve here and `tsc` does
not check it. It is kept as a record of what was tried, not as a fallback.

## custom-mcp-client/

An attempt to authenticate Sentinel itself as a custom Binance MCP OAuth client
(authorization_code + PKCE, client-ID-metadata-document, file-backed session).

**Binance rejected it:**

> The AI Agent you are using is not currently supported.

The settled architecture is the opposite: a Binance-supported Agent OS host
(Claude Code) owns the MCP session, and Sentinel's deterministic runtime reaches
Binance by emitting exact execution envelopes for that host to relay. See
`src/lib/mcp/host-relay.ts`.

This was re-confirmed empirically before the relay was built: `claude mcp serve`
starts an MCP server, but it re-exposes only Claude Code's own built-in tools
(Bash, Read, Edit, Agent, …) and proxies no connected MCP server. There is no
in-process bridge to the host's authenticated Binance session.

Do not spend further time on this path. Do not import from it.

### Contents

| File | Was |
|---|---|
| `provider.ts` | `FileOAuthProvider` — OAuth client provider, disk-backed session |
| `client.ts` | transport + `connect()` |
| `binance-client.ts` | `BinanceMcpClient` — the self-owned session invoker |
| `mcp-connect.ts` | one-time interactive authorization CLI |
| `oauth/` | the hosted client-metadata document served at `/oauth/…` |

The `McpToolInvoker` interface and the `McpAuthRequiredError` / `McpToolError`
classes originally lived in `binance-client.ts`. They are **production
contract** and now live in `src/lib/mcp/contract.ts`.

### Leftover credential

`.sentinel/mcp-session.json` may still hold OAuth tokens from this spike. It is
gitignored, but it is a live credential — revoke it on the Binance side and
delete the file.
