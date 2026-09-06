/**
 * EXPERIMENTAL / DEAD PATH — not imported by the Sentinel runtime.
 *
 * Binance rejected Sentinel as a custom MCP OAuth client:
 *   "The AI Agent you are using is not currently supported."
 *
 * The supported Agent OS host owns the Binance MCP session; Sentinel reaches
 * it through src/lib/mcp/host-relay.ts. Kept only as a record of the spike.
 * Excluded from tsconfig — see spikes/README.md.
 */
/**
 * BinanceMcpClient — the transport/auth layer beneath the Execution Adapter.
 *
 *   ExecutionAdapter → BinanceMcpClient → connect() → Binance Agent OS MCP
 *
 * Its only jobs are: hold the MCP session, invoke tools, parse results, and
 * translate "not authorized" into a clean, catchable signal. It contains no
 * trading logic — the adapter above decides *what* to call and enforces the
 * Guardian invariants.
 *
 * Authentication is a dependency here, never something the Guardian loop does
 * inline: if there is no usable OAuth session this throws McpAuthRequiredError
 * immediately. It never launches a browser, never authenticates interactively,
 * and never falls back to another transport. Run `npm run mcp:connect` once;
 * afterwards the same code path works unchanged.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { buildProvider, newTransport, SENTINEL_CLIENT_INFO } from "./client";

/** Raised when Sentinel has no usable MCP OAuth session. Code is stable. */
export class McpAuthRequiredError extends Error {
  readonly code = "MCP_AUTH_REQUIRED" as const;
  constructor(detail = "no MCP OAuth session; run `npm run mcp:connect`") {
    super(`MCP_AUTH_REQUIRED: ${detail}`);
    this.name = "McpAuthRequiredError";
  }
}

/** Raised when a tool exists and auth is fine, but the call itself failed. */
export class McpToolError extends Error {
  constructor(
    readonly tool: string,
    detail: string,
  ) {
    super(`MCP tool ${tool} failed: ${detail}`);
    this.name = "McpToolError";
  }
}

/**
 * The narrow surface the Execution Adapter depends on. Injecting this interface
 * (rather than the concrete client) is what lets the adapter be unit-tested
 * with mocked tool responses while the real OAuth session does not yet exist.
 */
export interface McpToolInvoker {
  call<T>(tool: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

interface ToolTextContent {
  type: string;
  text?: string;
}

export class BinanceMcpClient implements McpToolInvoker {
  private connection: { client: Client; transport: StreamableHTTPClientTransport } | null = null;

  /**
   * Connect lazily and reuse the session. Missing/invalid auth surfaces as
   * McpAuthRequiredError; we check for a persisted token before attempting the
   * handshake so a server process never even starts an interactive flow.
   */
  private async ensureConnected(): Promise<Client> {
    if (this.connection) return this.connection.client;

    const provider = buildProvider(); // no onRedirect: never interactive here
    if (!provider.hasTokens()) throw new McpAuthRequiredError();

    const { Client: ClientCtor } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const client = new ClientCtor(SENTINEL_CLIENT_INFO, { capabilities: {} });
    const transport = newTransport(provider);
    try {
      await client.connect(transport);
    } catch (err) {
      if (err instanceof UnauthorizedError) throw new McpAuthRequiredError(err.message);
      throw err;
    }
    this.connection = { client, transport };
    return client;
  }

  async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const client = await this.ensureConnected();

    let result;
    try {
      result = await client.callTool({ name: tool, arguments: args });
    } catch (err) {
      if (err instanceof UnauthorizedError) throw new McpAuthRequiredError(err.message);
      // A JSON-RPC/protocol error (e.g. Binance rejected the order) — surface it
      // as a tool error so the policy loop classifies it as EXECUTION_FAILED,
      // never a generic error.
      throw new McpToolError(tool, err instanceof Error ? err.message : String(err));
    }

    const text = (result.content as ToolTextContent[] | undefined ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");

    if (result.isError) throw new McpToolError(tool, text || "tool returned isError");
    if (!text) throw new McpToolError(tool, "empty result");

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new McpToolError(tool, `non-JSON result: ${text.slice(0, 160)}`);
    }
  }

  async close(): Promise<void> {
    if (!this.connection) return;
    await this.connection.transport.close().catch(() => {});
    this.connection = null;
  }
}

let singleton: BinanceMcpClient | null = null;

/** Process-wide Binance MCP client. */
export function getBinanceMcpClient(): BinanceMcpClient {
  singleton ??= new BinanceMcpClient();
  return singleton;
}
