/**
 * The one Sentinel surface. No routing, no second page.
 *
 * Read on the server so the first paint already carries real state, then the
 * client polls /api/state. No WebSocket: the runtime writes its state to disk
 * between host turns, so a short poll sees everything a socket would.
 */
import Console from "./console";
import { readConsoleState } from "@/lib/console/state";

// Always render against the live files, never a cached snapshot.
export const dynamic = "force-dynamic";

export default async function Page() {
  return <Console initial={readConsoleState()} />;
}
