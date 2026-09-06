/**
 * Sentinel configuration.
 *
 * Credentials live in env vars only. `.env*` is gitignored — see .gitignore.
 * The key backing these vars must have TRADE permission and no withdrawal
 * permission (SENTINEL_BUILD_PLAN.md §2).
 */

export const FUTURES_BASE_URL =
  process.env.BINANCE_FUTURES_BASE_URL ?? "https://fapi.binance.com";

/**
 * The one symbol Sentinel monitors. One position, one Guardian.
 * Frozen to ETHUSDC after the spike: the execution account's collateral is USDC
 * (single-asset margin), so the tradeable contract is the USDC-margined ETHUSDC
 * perpetual, not ETHUSDT.
 */
export const SYMBOL = process.env.SENTINEL_SYMBOL ?? "ETHUSDC";

/** Binance rejects signed requests older than this many ms. */
export const RECV_WINDOW = 5_000;

export interface Credentials {
  apiKey: string;
  apiSecret: string;
}

/**
 * Reads the execution-account credentials. These are the *only* credentials in
 * the system: position state used for validation and the order that acts on it
 * must come from the same account.
 */
export function requireCredentials(): Credentials {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error(
      "BINANCE_API_KEY and BINANCE_API_SECRET must be set. Copy .env.example " +
        "to .env.local and fill in the execution sub-account's TRADE-only key.",
    );
  }
  return { apiKey, apiSecret };
}

export function isTestnet(): boolean {
  return FUTURES_BASE_URL.includes("testnet");
}

/* -------------------------------------------------------------------------- *
 *  Binance Agent OS (MCP) — the execution path
 *
 *  Settled architecture (post Day-1 spike): Agent OS is Sentinel's execution
 *  infrastructure, not a decorative integration. It is a standard remote
 *  Streamable-HTTP MCP server protected by OAuth 2.1 + PKCE, so Sentinel's own
 *  runtime — not Claude Code — owns the connection.
 *
 *    protected resource : https://agent.binance.com/mcp/agentic
 *    authorization server: https://agent.binance.com
 *      authorize : https://accounts.binance.com/agentic-oauth/authorize
 *      token     : https://accounts.binance.com/oauth-agentic/token
 *    grant       : authorization_code + S256, public client (auth method "none")
 *    client id   : a hosted "client ID metadata document" URL
 *                  (client_id_metadata_document_supported: true; no DCR endpoint)
 * -------------------------------------------------------------------------- */

/** The Binance Agent OS MCP endpoint Sentinel connects to. */
export const MCP_SERVER_URL =
  process.env.BINANCE_MCP_URL ?? "https://agent.binance.com/mcp/agentic";

/**
 * Public HTTPS URL of Sentinel's OAuth client-metadata document. Binance uses
 * this URL *as* the client_id (there is no dynamic-registration endpoint), so
 * it must be reachable over HTTPS and have a non-root path. In this repo the
 * document is served at `/oauth/client-metadata.json` (see public/). Set this
 * to the deployed origin + that path, e.g.
 *   https://sentinel.example.com/oauth/client-metadata.json
 * Undefined until deployed — the connect script explains the requirement.
 */
export const MCP_OAUTH_CLIENT_METADATA_URL =
  process.env.SENTINEL_OAUTH_CLIENT_METADATA_URL;

/**
 * OAuth redirect (callback) URL. For the one-time CLI authorization the connect
 * script listens on this localhost address; RFC 8252 permits loopback redirects
 * for native/CLI clients. Must also appear in redirect_uris of the hosted
 * client-metadata document.
 */
export const MCP_OAUTH_REDIRECT_URL =
  process.env.SENTINEL_OAUTH_REDIRECT_URL ?? "http://localhost:8787/callback";

/**
 * Directory holding the persisted OAuth session (tokens + PKCE verifier).
 * Gitignored — it is a live credential. Never commit or log its contents.
 */
export const MCP_AUTH_DIR = process.env.SENTINEL_AUTH_DIR ?? ".sentinel";

/** Human-readable client name advertised in the OAuth client metadata. */
export const MCP_CLIENT_NAME = "Sentinel Risk Guardian";

/* -------------------------------------------------------------------------- *
 *  Agent OS host relay
 *
 *  Sentinel does not own the Binance MCP session — a supported Agent OS host
 *  (Claude Code) does. Verified empirically: `claude mcp serve` re-exposes only
 *  Claude Code's own built-in tools, so there is no in-process bridge to its
 *  authenticated Binance session. The runtime therefore emits exact execution
 *  envelopes and the host relays them.
 *
 *  The journal is the record of everything that crossed that boundary. It holds
 *  order intent and raw Binance responses — operational evidence, not a
 *  credential, but still gitignored.
 * -------------------------------------------------------------------------- */

/** Append-only JSONL record of every relayed MCP interaction. */
export const RELAY_JOURNAL_PATH =
  process.env.SENTINEL_RELAY_JOURNAL ?? ".sentinel/relay/journal.jsonl";

/** Guardian state: which policy is in force, its status, and the live cycle. */
export const GUARDIAN_STATE_PATH =
  process.env.SENTINEL_GUARDIAN_STATE ?? ".sentinel/guardian.json";

/** Append-only domain event log. The Agent Feed's only data source. */
export const EVENT_LOG_PATH =
  process.env.SENTINEL_EVENT_LOG ?? ".sentinel/events.jsonl";
