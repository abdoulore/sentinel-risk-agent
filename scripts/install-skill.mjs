/**
 * Installs the Sentinel skill where Claude Code will find it.
 *
 * The canonical copy lives in this repo (agent/skills/sentinel) so it is
 * version-controlled. Claude Code discovers skills under the directory it was
 * started in — which is the PARENT of this repo, because that is where the
 * binance-mcp-server connection is configured. So the skill is copied up.
 *
 *   npm run skill:install
 */
import { mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const src = resolve("agent/skills/sentinel");
const dest = resolve("..", ".claude", "skills", "sentinel");

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const s = join(from, entry);
    const d = join(to, entry);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

copyTree(src, dest);
console.log(`Installed Sentinel skill:\n  ${src}\n  -> ${dest}\n`);
console.log("Restart Claude Code (or /doctor) if it does not appear immediately.");
