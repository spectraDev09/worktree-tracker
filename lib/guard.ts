import { TICKET_RE } from "./config";

// The server listens on 127.0.0.1 only, but any page open in the browser can still send requests
// to it. Three checks keep those out:
//  - Host must be loopback, which defeats DNS rebinding (an attacker's name pointing at 127.0.0.1)
//  - a cross-site Origin / Sec-Fetch-Site is refused outright
//  - every mutating request needs a custom header, which a cross-origin page can only send after
//    a CORS preflight that this server never approves
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const hostnameOf = (hostHeader: string) => hostHeader.replace(/:\d+$/, "");

export function guard(req: Request): Response | null {
  const host = req.headers.get("host");
  if (!host || !LOOPBACK.has(hostnameOf(host))) return deny("bad host");
  const origin = req.headers.get("origin");
  if (origin) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      return deny("bad origin");
    }
    if (!LOOPBACK.has(o.hostname) || o.host !== host) return deny("cross-origin");
  }
  if (req.headers.get("sec-fetch-site") === "cross-site") return deny("cross-site");
  if (req.method !== "GET" && req.headers.get("x-grubbs-worktrees") !== "1") return deny("missing header");
  return null;
}

const deny = (why: string) => Response.json({ error: `forbidden: ${why}` }, { status: 403 });

export function badTicket(ticket: string): Response | null {
  return TICKET_RE.test(ticket) ? null : Response.json({ error: "ticket must be a number" }, { status: 400 });
}
