/**
 * Establish (and verify) Sentinel's own MCP connection to Binance Agent OS.
 *
 *   npm run mcp:discover    read-only: prove Sentinel's runtime reaches the
 *                           Agent OS OAuth discovery endpoints. No token, no
 *                           hosted client-metadata document required.
 *
 *   npm run mcp:connect     one-time interactive OAuth (authorization_code +
 *                           PKCE). Opens a loopback listener, prints the Binance
 *                           authorize URL, exchanges the returned code for a
 *                           token, persists the session, then lists the tools
 *                           the server exposes to Sentinel.
 *
 * This is the spike that gates building upward: it shows Sentinel — not Claude
 * Code — can hold the MCP session and invoke Agent OS tools. It performs no
 * trades; it only lists tools (and optionally reads a price).
 */
import http from "node:http";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  MCP_OAUTH_CLIENT_METADATA_URL,
  MCP_OAUTH_REDIRECT_URL,
  MCP_SERVER_URL,
} from "@/lib/config";
import { SENTINEL_CLIENT_INFO, buildProvider, newTransport } from "./client";

const DISCOVER_ONLY = process.argv.includes("--discover");

function log(step: string, detail = "") {
  console.log(`  ${step}${detail ? ` - ${detail}` : ""}`);
}

/** Fetch a JSON metadata endpoint, tolerating 404s. */
async function getJson(url: string): Promise<unknown | null> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Prove reachability of the Agent OS OAuth surface from Sentinel's own runtime.
 * Runs today with no credentials and no deployed client-metadata document.
 */
async function discover(): Promise<void> {
  console.log("MCP discovery -", MCP_SERVER_URL);
  const origin = new URL(MCP_SERVER_URL).origin;

  const resource = (await getJson(
    `${origin}/.well-known/oauth-protected-resource`,
  )) as { authorization_servers?: string[] } | null;
  if (!resource) {
    console.log("  [FAIL] no protected-resource metadata - endpoint unreachable");
    process.exit(1);
  }
  log("[ok] protected-resource metadata", `auth servers: ${resource.authorization_servers?.join(", ")}`);

  const authServer = resource.authorization_servers?.[0] ?? origin;
  const asMeta = (await getJson(
    `${authServer}/.well-known/oauth-authorization-server`,
  )) as
    | {
        authorization_endpoint?: string;
        token_endpoint?: string;
        grant_types_supported?: string[];
        code_challenge_methods_supported?: string[];
        client_id_metadata_document_supported?: boolean;
      }
    | null;
  if (!asMeta) {
    console.log("  [FAIL] no authorization-server metadata");
    process.exit(1);
  }
  log("[ok] authorization-server metadata");
  log("     authorize", asMeta.authorization_endpoint ?? "?");
  log("     token", asMeta.token_endpoint ?? "?");
  log("     grants", (asMeta.grant_types_supported ?? []).join(", ") || "?");
  log("     PKCE", (asMeta.code_challenge_methods_supported ?? []).join(", ") || "?");
  log("     url-based client id", String(asMeta.client_id_metadata_document_supported === true));

  if (!asMeta.grant_types_supported?.includes("refresh_token")) {
    console.log(
      "\n  [warn] refresh_token grant not advertised. Verify the token response\n" +
        "         includes a refresh_token, or unattended runs will need periodic\n" +
        "         re-consent when the access token expires.",
    );
  }
  console.log("\nDiscovery OK - Sentinel's runtime reaches Agent OS OAuth. Run `npm run mcp:connect` to authorize.\n");
}

/** Wait for the OAuth redirect to hit the loopback listener and yield ?code=. */
function waitForCode(redirectUrl: URL): Promise<string> {
  const port = Number(redirectUrl.port || "80");
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname !== redirectUrl.pathname) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.setHeader("content-type", "text/html");
      res.end(
        `<html><body style="font-family:system-ui;background:#080A0D;color:#e6e6e6">` +
          `<h2>Sentinel</h2><p>${code ? "Authorization received. You can close this tab." : "Authorization failed: " + error}</p>` +
          `</body></html>`,
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(`authorization failed: ${error ?? "no code returned"}`));
    });
    server.on("error", reject);
    server.listen(port, () => {
      console.log(`  [ok] loopback listener on ${redirectUrl.origin}`);
    });
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for authorization (5 min)"));
    }, 5 * 60_000).unref();
  });
}

async function connectInteractive(): Promise<void> {
  console.log("MCP connect -", MCP_SERVER_URL);

  if (!MCP_OAUTH_CLIENT_METADATA_URL) {
    console.log(
      "\n  [FAIL] SENTINEL_OAUTH_CLIENT_METADATA_URL is not set.\n\n" +
        "  Binance identifies this client by the HTTPS URL of a hosted\n" +
        "  client-metadata document (no dynamic registration). Deploy\n" +
        "  public/oauth/client-metadata.json, fill in YOUR_SENTINEL_HOST, then set:\n" +
        "    SENTINEL_OAUTH_CLIENT_METADATA_URL=https://<host>/oauth/client-metadata.json\n" +
        "  See public/oauth/README.md.\n",
    );
    process.exit(1);
  }

  const redirectUrl = new URL(MCP_OAUTH_REDIRECT_URL);
  const provider = buildProvider((authUrl) => {
    console.log("\n  Authorize Sentinel in your browser:\n");
    console.log(`    ${authUrl.toString()}\n`);
  });

  const client = new Client(SENTINEL_CLIENT_INFO, { capabilities: {} });

  if (provider.hasTokens()) {
    // Already authorized on a previous run; the SDK will refresh if needed.
    try {
      await client.connect(newTransport(provider));
      await report(client);
      return;
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      log("[warn] saved session no longer valid, re-authorizing");
    }
  }

  // First connect triggers redirectToAuthorization then throws Unauthorized.
  const transport = newTransport(provider);
  const codePromise = waitForCode(redirectUrl);
  try {
    await client.connect(transport);
    // Connected without interaction (unexpected but fine).
    await report(client);
    return;
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
  }

  const code = await codePromise;
  log("[ok] authorization code received");
  await transport.finishAuth(code);
  log("[ok] token acquired and session persisted");

  // Retry the connection with a fresh transport now that tokens exist.
  const client2 = new Client(SENTINEL_CLIENT_INFO, { capabilities: {} });
  await client2.connect(newTransport(provider));
  await report(client2);
}

/** List tools and, if a price ticker is exposed, read one (read-only). */
async function report(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  console.log(`\n  [ok] connected - ${tools.length} tools available to Sentinel`);
  for (const name of ["futures_usds_symbolPriceTicker", "futures_usds_positionInformationV2"]) {
    if (tools.some((t) => t.name === name)) log("     found", name);
  }

  const ticker = tools.find((t) => t.name === "futures_usds_symbolPriceTicker");
  if (ticker) {
    try {
      const result = await client.callTool({
        name: ticker.name,
        arguments: { symbol: "ETHUSDC" },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      log("[ok] read tool invoked from Sentinel's runtime", text.slice(0, 120));
    } catch (err) {
      log("[warn] price read failed", err instanceof Error ? err.message : String(err));
    }
  }
  console.log("\nSentinel owns the MCP session. Claude Code is not in the path.\n");
}

async function main() {
  if (DISCOVER_ONLY) await discover();
  else await connectInteractive();
}

main().catch((err) => {
  console.error("\nmcp-connect aborted:", err instanceof Error ? err.message : err);
  process.exit(1);
});
