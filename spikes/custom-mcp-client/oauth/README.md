# Sentinel OAuth client-metadata document

`client-metadata.json` in this folder is Sentinel's **OAuth client-metadata
document**. Next serves `public/` at the site root, so once deployed it is
reachable at:

```
https://<your-host>/oauth/client-metadata.json
```

Binance Agent OS advertises `client_id_metadata_document_supported: true` and
exposes **no** dynamic client-registration endpoint. So instead of registering,
Sentinel identifies itself by the **HTTPS URL of this document** — that URL *is*
the `client_id`.

## Before first use

1. Deploy Sentinel (or expose it over HTTPS) so this file is publicly fetchable.
2. Replace every `YOUR_SENTINEL_HOST` in `client-metadata.json` with the real
   host. The `client_id` field must equal the document's own URL.
3. Ensure `redirect_uris` contains:
   - `http://localhost:8787/callback` — used by the one-time `npm run mcp:connect`
     CLI authorization (loopback redirects are permitted for native clients,
     RFC 8252).
   - your deployed callback (e.g. `https://<your-host>/api/mcp/callback`) if you
     later drive consent from the web app.
4. Point Sentinel at it:
   ```
   SENTINEL_OAUTH_CLIENT_METADATA_URL=https://<your-host>/oauth/client-metadata.json
   ```

## Notes

- The values here must match `FileOAuthProvider.clientMetadata` in
  `src/lib/mcp/provider.ts` (`redirect_uris`, `token_endpoint_auth_method`,
  `grant_types`, `response_types`).
- `token_endpoint_auth_method: none` — this is a public client using PKCE
  (S256); there is no client secret to store.
- This file is **not** a secret. The OAuth session tokens (under `.sentinel/`)
  are — those are gitignored and never committed.
