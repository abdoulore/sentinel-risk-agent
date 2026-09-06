/**
 * Binance Agent OS MCP client for Sentinel's runtime.
 *
 * This is the execution surface settled after the Day-1 spike: account state,
 * positions, klines, orders, reduceOnly and fills all flow through here. The
 * connection is owned by Sentinel — the OAuth session lives on disk (see
 * FileOAuthProvider), so no Claude Code / agent host sits between Sentinel and
 * Binance.
 *
 * `connect()` is the non-interactive runtime path: it assumes a session already
 * exists (created once via `npm run mcp:connect`) and lets the SDK transparently
 * refresh the access token when possible. If there is no usable session it
 * throws UnauthorizedError rather than trying to open a browser — a server
 * process must never block on interactive consent.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_SERVER_URL } from "@/lib/config";
import { FileOAuthProvider, type ProviderOptions } from "./provider";

export const SENTINEL_CLIENT_INFO = {
  name: "sentinel",
  version: "0.1.0",
} as const;

export function buildProvider(
  onRedirect?: (url: URL) => void,
  opts: Omit<ProviderOptions, "onRedirect"> = {},
): FileOAuthProvider {
  return new FileOAuthProvider({ ...opts, onRedirect });
}

export function newTransport(
  provider: FileOAuthProvider,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    authProvider: provider,
  });
}

export interface McpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  provider: FileOAuthProvider;
}

/**
 * Runtime connect. Requires an existing authorized session. Throws
 * UnauthorizedError (from the SDK) if the session is missing or unrefreshable —
 * the caller should surface "re-run mcp:connect", not prompt for consent.
 */
export async function connect(): Promise<McpConnection> {
  const provider = buildProvider();
  const transport = newTransport(provider);
  const client = new Client(SENTINEL_CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, provider };
}
