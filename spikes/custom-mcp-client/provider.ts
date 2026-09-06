/**
 * OAuth client provider for the Binance Agent OS MCP server.
 *
 * Implements the SDK's `OAuthClientProvider` with a small file-backed session
 * so Sentinel's own runtime holds the OAuth tokens — Claude Code is not in the
 * path. The session (access/refresh tokens + PKCE verifier) is a live
 * credential: it lives under MCP_AUTH_DIR, which is gitignored, and is never
 * logged.
 *
 * Binance advertises `client_id_metadata_document_supported: true` and exposes
 * no dynamic-registration endpoint, so we identify the client by the HTTPS URL
 * of a hosted metadata document (MCP_OAUTH_CLIENT_METADATA_URL). The SDK then
 * uses that URL as the client_id and skips registration entirely
 * (see @modelcontextprotocol/sdk client/auth.js, the url-based-client-id path).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  MCP_AUTH_DIR,
  MCP_CLIENT_NAME,
  MCP_OAUTH_CLIENT_METADATA_URL,
  MCP_OAUTH_REDIRECT_URL,
} from "@/lib/config";

/** Everything we persist for one authorized MCP session. */
interface AuthSession {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

export interface ProviderOptions {
  /** Where to redirect the user agent when interactive authorization begins. */
  onRedirect?: (authorizationUrl: URL) => void;
  /** Overrides for testing; defaults come from config/env. */
  authDir?: string;
  redirectUrl?: string;
  clientMetadataUrl?: string;
}

const SESSION_FILE = "mcp-session.json";

export class FileOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;

  private readonly authDir: string;
  private readonly sessionPath: string;
  private readonly _redirectUrl: string;
  private readonly onRedirect?: (url: URL) => void;
  private session: AuthSession;

  /** The most recent authorization URL handed to `redirectToAuthorization`. */
  lastAuthorizationUrl?: URL;

  constructor(opts: ProviderOptions = {}) {
    this.authDir = opts.authDir ?? MCP_AUTH_DIR;
    this.sessionPath = join(this.authDir, SESSION_FILE);
    this._redirectUrl = opts.redirectUrl ?? MCP_OAUTH_REDIRECT_URL;
    this.clientMetadataUrl =
      opts.clientMetadataUrl ?? MCP_OAUTH_CLIENT_METADATA_URL;
    this.onRedirect = opts.onRedirect;
    this.session = this.load();
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  /**
   * Must mirror the hosted client-metadata document (public/oauth/…): the
   * authorization server fetches that document, but the SDK also consults this
   * getter locally, so they have to agree on redirect_uris and auth method.
   */
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: MCP_CLIENT_NAME,
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /**
   * Undefined on purpose: with a client-metadata-document URL configured, the
   * SDK derives `client_id` from `clientMetadataUrl` and never registers, so no
   * client information is stored or needed here.
   */
  clientInformation(): undefined {
    return undefined;
  }

  tokens(): OAuthTokens | undefined {
    return this.session.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.session.tokens = tokens;
    this.persist();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizationUrl = authorizationUrl;
    this.onRedirect?.(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.session.codeVerifier = codeVerifier;
    this.persist();
  }

  codeVerifier(): string {
    if (!this.session.codeVerifier) {
      throw new Error(
        "No PKCE code verifier in the saved session. Re-run `npm run mcp:connect`.",
      );
    }
    return this.session.codeVerifier;
  }

  state(): string {
    const state = randomUUID();
    this.session.state = state;
    this.persist();
    return state;
  }

  /** Drop stored credentials the server has told us are stale. */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.session = {};
    else if (scope === "tokens") delete this.session.tokens;
    else if (scope === "verifier") delete this.session.codeVerifier;
    this.persist();
  }

  /** True once an access token has been persisted. */
  hasTokens(): boolean {
    return Boolean(this.session.tokens?.access_token);
  }

  private load(): AuthSession {
    try {
      return JSON.parse(readFileSync(this.sessionPath, "utf8")) as AuthSession;
    } catch {
      return {};
    }
  }

  private persist(): void {
    mkdirSync(this.authDir, { recursive: true });
    // 0o600: readable only by the owner — this file is a bearer credential.
    writeFileSync(this.sessionPath, JSON.stringify(this.session, null, 2), {
      mode: 0o600,
    });
  }
}
