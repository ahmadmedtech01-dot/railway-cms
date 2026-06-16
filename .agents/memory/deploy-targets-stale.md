---
name: Two independent deploy targets (Railway + Cloudflare Worker)
description: Prod has TWO separately-deployed pieces that drift out of sync; how each symptom maps to which one is stale.
---

Production is served by TWO independently-deployed artifacts. A code change in the repo is NOT live until the relevant target is redeployed, and they are deployed by completely different mechanisms — so one can be fresh while the other is months stale.

1. **Railway** (the Node/Express app + the built React client) — origin at the app domain. Deploy = Railway dashboard → `railway-cms` service → Redeploy (does NOT auto-deploy on push to main; must be triggered manually). Owns: server session/rotation logic, `/api/...` routes, the bundled `index-*.js` client (embed-player), window/progress logic.

2. **Cloudflare Worker** (`cloudflare-worker/worker.js`) — edge at `video.syanmedtech.com`. There is NO `wrangler.toml` in the repo; it is deployed by pasting `worker.js` into the Cloudflare dashboard. Owns: edge caching of `/seg/` + stealth chunks, and the passthrough of `/api/player/.../stream/{window,master,secret,chunk}`.

## Symptom → which target is stale
- **`net::ERR_CONNECTION_CLOSED` on `/stream/window/` (or master/secret)** = stale **Worker**. The fixed worker strips hop-by-hop headers (Transfer-Encoding/Connection/Keep-Alive — illegal on H2 frames) AND fully buffers window/master/secret as `arrayBuffer` before responding (streaming the body lets a mid-stream Railway keep-alive close tear down the browser connection → 0 bytes → ERR_CONNECTION_CLOSED). If you see this symptom, the deployed worker predates that fix regardless of what the repo says.
- **Rotation loop / `windowEnd:295` window inflation / wrong resume position** = stale **Railway** (server) and/or stale client bundle.

**Why this matters:** It is easy to "fix" a bug in the repo, see prod still broken, and wrongly conclude the fix failed. Always confirm WHICH target the symptom belongs to and whether THAT target was redeployed. Timestamp check: compare the commit time of the fix against the log timestamps — logs captured before the commit cannot reflect it.
