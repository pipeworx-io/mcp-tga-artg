interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * TGA ARTG — the Australian Register of Therapeutic Goods, the Therapeutic
 * Goods Administration's register of every medicine, biological and medical
 * device approved for supply in AUSTRALIA.
 *
 * THIS PACK DOES NOT USE THE DOCUMENTED "ARTG Search" WEB TOOL. That tool
 * (linked from tga.gov.au and, as of 2026, a beta Power Apps/Power BI portal
 * at compliance.health.gov.au/artg) is interactive-only — a rendered visual,
 * with no query API behind it — and tga.gov.au itself is unreachable from
 * our egress (its Akamai front end times out on every request, even a bare
 * static PDF; not a 403, a silent connection hold).
 *
 * Instead this pack calls the WCF JSON web service that actually BACKS the
 * ARTG register, at a *different*, reachable host: data.tga.gov.au. This is
 * the same service TGA's own internal client library (aehrc/tga-feed-client
 * on GitHub) is built against, and it is keyless, live, and per-query —
 * proxy, not mirror. Confirmed live 2026-09-23:
 *
 *     GET https://data.tga.gov.au/ARTGSearch/ARTGWebService.svc/JSON/ARTGValueSearch/
 *         ?ingredient=paracetamol&pagestart=1&pageend=25
 *
 * TWO TRAPS:
 *
 * 1. THE PATH SEGMENT MUST BE UPPERCASE "JSON" — lowercase "json" (the form
 *    quoted in third-party documentation) 404s with a generic WCF
 *    "Endpoint not found" page. Case matters on this whole path.
 *
 * 2. `pagestart`/`pageend` ARE A 1-INDEXED, INCLUSIVE RECORD RANGE, NOT A
 *    PAGE NUMBER. `pagestart=3&pageend=5` returns records 3, 4 and 5 (three
 *    rows), not "page 3 of 5". Omitting BOTH silently returns the ENTIRE
 *    ARTG register (97,087 entries on 2026-09-25) in ARTG-ID order,
 *    ignoring every other filter — so every call here sends an explicit
 *    range. Every response also carries `TotalRecords` for the filtered set,
 *    which is what makes offset paging exact (artg_search / artg_list).
 *
 * `ARTGValueSearch` filtered by `licenceid` ALONE returns the single full
 * record (sponsor, every ingredient with strength, indications, PI/CMI
 * document links, status, dates) — so it doubles as entry detail; there is
 * no separate lookup-by-id endpoint that actually resolves on this host.
 */


const BASE = 'https://data.tga.gov.au/ARTGSearch/ARTGWebService.svc/JSON';
const UA = 'pipeworx-tga-artg-mcp/1.0 (+https://pipeworx.io)';
const SOURCE = 'TGA ARTG (Australian Register of Therapeutic Goods)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(
    url,
    { ...init, headers: { Accept: 'application/json', 'User-Agent': UA, ...(init?.headers ?? {}) } },
    'TGA ARTG',
  );
}

const clamp = (n: unknown, d: number, max: number) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : d;
};

function notFound(reason: string, hint: string, extra: Record<string, unknown> = {}) {
  return { found: false, reason, hint, source: SOURCE, jurisdiction: 'Australia', ...extra };
}

// Every response says where it came from and when. This is a live proxy, so
// the source date IS the fetch time — the register has no published version.
const provenance = (url: URL) => ({
  source: SOURCE,
  source_url: url.toString(),
  data_as_of: new Date().toISOString(),
  jurisdiction: 'Australia',
});

// An argument this pack does not implement must be REFUSED, not dropped.
// `offset` used to be accepted and silently ignored, so an enumeration loop
// re-read page one forever and looked successful (fleet #2422). Underscore
// args are gateway-injected plumbing and are exempt.
function rejectUnknownArgs(tool: string, a: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(a).filter((k) => !k.startsWith('_') && !allowed.includes(k));
  if (unknown.length) {
    throw new Error(
      `${tool} does not accept ${unknown.map((k) => `"${k}"`).join(', ')}. Accepted arguments: ${allowed.join(', ')}.`,
    );
  }
}

// 0-based offset → the upstream's 1-indexed inclusive record range.
function offsetArg(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`offset must be a non-negative integer, got ${JSON.stringify(v)}.`);
  return n;
}

function setRange(url: URL, offset: number, limit: number) {
  url.searchParams.set('pagestart', String(offset + 1));
  url.searchParams.set('pageend', String(offset + limit));
}

// The upstream reports TotalRecords for the whole filtered set, so paging is
// exact rather than inferred from a full page.
const paging = (total: number | undefined, offset: number, returned: number) => {
  const t = typeof total === 'number' ? total : null;
  const has_more = t != null ? offset + returned < t : null;
  return { total: t, offset, count: returned, has_more, truncated: has_more, next_offset: has_more ? offset + returned : null };
};

// ---- upstream shapes (trimmed to what we read) -------------------------

interface ArtgIngredient { Name?: string; Strength?: string; FormulationType?: string }
interface ArtgProduct {
  Name?: string;
  Ingredients?: ArtgIngredient[];
  StandardIndications?: string[];
  SpecificIndications?: string[];
  Components?: { DosageForm?: string; RouteOfAdministration?: string }[];
}
interface ArtgSponsor { Name?: string }
interface ArtgRow {
  LicenceId?: string;
  Name?: string;
  EntryType?: string;
  ProductCategory?: string;
  Status?: string;
  StartDate?: string;
  Sponsor?: ArtgSponsor;
  Products?: ArtgProduct[];
  ProductInformation?: { DocumentLink?: string };
  ConsumerInformation?: { DocumentLink?: string };
}

async function artgSearch(url: URL): Promise<{ RequestedPageEnd?: number; RequestedPageStart?: number; TotalRecords?: number; Results?: ArtgRow[] }> {
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, 'TGA ARTG');
  const text = await res.text();
  // A 200 with an HTML "Endpoint not found" body is how a bad path/case
  // shows up on this WCF service — guard against silently parsing that as
  // an empty result set.
  if (text.trim().startsWith('<')) {
    throw new Error(`TGA ARTG returned an HTML error page instead of JSON for ${url.pathname}${url.search} — the WCF endpoint path or case is wrong.`);
  }
  return JSON.parse(text);
}

const activeIngredients = (p: ArtgProduct) =>
  (p.Ingredients ?? [])
    .filter((i) => (i.FormulationType ?? '').toLowerCase() === 'active')
    .map((i) => ({ name: (i.Name ?? '').trim(), strength: i.Strength || null }));

const shapeSummaryRow = (r: ArtgRow) => ({
  artg_id: r.LicenceId ?? null,
  name: r.Name ?? null,
  entry_type: r.EntryType ?? null,
  product_category: r.ProductCategory ?? null,
  status: r.Status || 'unknown', // never guessed: absent upstream → 'unknown'
  start_date: r.StartDate ?? null,
  sponsor: r.Sponsor?.Name ?? null,
  active_ingredients: (r.Products ?? []).flatMap(activeIngredients),
  pi_document_url: r.ProductInformation?.DocumentLink || null,
  cmi_document_url: r.ConsumerInformation?.DocumentLink || null,
});

const SEARCH_ARGS = ['name', 'ingredient', 'product', 'sponsor', 'manufacturer', 'entry_type', 'limit', 'offset'];

async function search(a: Record<string, unknown>) {
  rejectUnknownArgs('artg_search', a, SEARCH_ARGS);
  const name = a.name != null ? String(a.name).trim() : '';
  const ingredient = a.ingredient != null ? String(a.ingredient).trim() : '';
  const product = a.product != null ? String(a.product).trim() : '';
  const sponsor = a.sponsor != null ? String(a.sponsor).trim() : '';
  const manufacturer = a.manufacturer != null ? String(a.manufacturer).trim() : '';
  if (!name && !ingredient && !product && !sponsor && !manufacturer) {
    return notFound(
      'no_search_terms',
      'Pass at least one of name, ingredient, product, sponsor, or manufacturer. Example: {"ingredient": "paracetamol"}. To walk the whole register instead, use artg_list.',
    );
  }
  const entryType = a.entry_type != null ? String(a.entry_type).trim() : '';
  const limit = clamp(a.limit, 25, 100);
  const offset = offsetArg(a.offset);

  const url = new URL(`${BASE}/ARTGValueSearch/`);
  if (name) url.searchParams.set('name', name);
  if (ingredient) url.searchParams.set('ingredient', ingredient);
  if (product) url.searchParams.set('product', product);
  if (sponsor) url.searchParams.set('sponsor', sponsor);
  if (manufacturer) url.searchParams.set('manufacturer', manufacturer);
  if (entryType) url.searchParams.set('entrytype', entryType);
  setRange(url, offset, limit);

  const query = {
    name: name || null, ingredient: ingredient || null, product: product || null,
    sponsor: sponsor || null, manufacturer: manufacturer || null, entry_type: entryType || null,
  };
  const data = await artgSearch(url);
  const rows = data.Results ?? [];
  if (!rows.length) {
    if (offset > 0 && typeof data.TotalRecords === 'number' && data.TotalRecords > 0) {
      return notFound(
        'offset_past_end',
        `offset ${offset} is past the end of this result set, which has ${data.TotalRecords} entries.`,
        { ...query, total: data.TotalRecords, offset, source_url: url.toString() },
      );
    }
    return notFound(
      'no_artg_entries',
      'No Australian ARTG entry matched. ARTG covers goods approved for supply in Australia only — a drug authorised elsewhere may not be registered here under the same name.',
      { ...query, source_url: url.toString() },
    );
  }
  return {
    ...provenance(url),
    query,
    ...paging(data.TotalRecords, offset, rows.length),
    entries: rows.map(shapeSummaryRow),
  };
}

// ---- enumeration: the whole register, in ARTG-ID order ------------------

async function list(a: Record<string, unknown>) {
  rejectUnknownArgs('artg_list', a, ['entry_type', 'limit', 'offset']);
  const entryType = a.entry_type != null ? String(a.entry_type).trim() : '';
  const limit = clamp(a.limit, 100, 100);
  const offset = offsetArg(a.offset);

  const url = new URL(`${BASE}/ARTGValueSearch/`);
  if (entryType) url.searchParams.set('entrytype', entryType);
  setRange(url, offset, limit);

  const data = await artgSearch(url);
  const rows = data.Results ?? [];
  if (!rows.length) {
    return notFound(
      offset > 0 && (data.TotalRecords ?? 0) > 0 ? 'offset_past_end' : 'no_artg_entries',
      entryType
        ? `No ARTG entries for entry_type "${entryType}" at offset ${offset}. entry_type matches the start of the ARTG entry type, e.g. "Medicine", "Medicine Registered", "Medicine Listed", "Biological", "Medical Device".`
        : `No ARTG entries at offset ${offset}.`,
      { entry_type: entryType || null, total: data.TotalRecords ?? null, offset, source_url: url.toString() },
    );
  }
  return {
    ...provenance(url),
    order: 'ARTG ID ascending (IDs are issued sequentially, so the newest entries are at the end)',
    entry_type: entryType || null,
    ...paging(data.TotalRecords, offset, rows.length),
    entries: rows.map(shapeSummaryRow),
  };
}

// ---- recent additions: walk back from the tail of the ID-ordered register ----
//
// The upstream's dateStart/dateEnd parameters exist in its WSDL but are
// IGNORED (probed 2026-09-25: every date format returns the unfiltered
// total), so there is no server-side date filter. IDs are issued in sequence,
// so new entries sit at the tail; we page backwards until a whole page starts
// before `since`. This sees NEW entries only — a cancellation or variation to
// an existing entry does not move it, and the response says so.

const RECENT_PAGE = 100;
const RECENT_MAX_PAGES = 5;

async function recent(a: Record<string, unknown>) {
  rejectUnknownArgs('artg_recent', a, ['since', 'entry_type']);
  const since = a.since != null ? String(a.since).trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since))) {
    return notFound('bad_since', 'Pass since as an ISO date, e.g. {"since": "2026-09-01"}.', { since: since || null });
  }
  const entryType = a.entry_type != null ? String(a.entry_type).trim() : '';

  const make = (offset: number, limit: number) => {
    const u = new URL(`${BASE}/ARTGValueSearch/`);
    if (entryType) u.searchParams.set('entrytype', entryType);
    setRange(u, offset, limit);
    return u;
  };

  // One-row probe for the current total, then walk back from the end.
  const probeUrl = make(0, 1);
  const total = (await artgSearch(probeUrl)).TotalRecords;
  if (typeof total !== 'number') {
    throw new Error('TGA ARTG did not report TotalRecords, so the end of the register cannot be located.');
  }

  const found: ArtgRow[] = [];
  let end = total;
  let pages = 0;
  let reachedSince = false;
  let lastUrl = probeUrl;
  while (end > 0 && pages < RECENT_MAX_PAGES) {
    const start = Math.max(0, end - RECENT_PAGE);
    lastUrl = make(start, end - start);
    const rows = (await artgSearch(lastUrl)).Results ?? [];
    pages++;
    const hits = rows.filter((r) => (r.StartDate ?? '') >= since);
    found.push(...hits);
    if (rows.every((r) => (r.StartDate ?? '') < since)) { reachedSince = true; break; }
    end = start;
  }
  if (end <= 0) reachedSince = true;

  found.sort((x, y) => Number(y.LicenceId ?? 0) - Number(x.LicenceId ?? 0));
  return {
    ...provenance(lastUrl),
    since,
    entry_type: entryType || null,
    change_types_covered: ['new_entry'],
    not_covered: 'Cancellations, suspensions and variations to existing entries are not exposed by this source with a date, so they are not reported here. Re-read an entry with artg_entry to see its current status.',
    count: found.length,
    complete: reachedSince,
    note: reachedSince
      ? undefined
      : `Stopped after scanning the newest ${pages * RECENT_PAGE} entries without reaching ${since}; there are more. Use a later since, or walk the register with artg_list.`,
    entries: found.map(shapeSummaryRow),
  };
}

async function entry(a: Record<string, unknown>) {
  rejectUnknownArgs('artg_entry', a, ['id']);
  const id = a.id != null ? String(a.id).trim() : '';
  if (!id) {
    return notFound('no_id', 'Pass id, the ARTG number (LicenceId), e.g. {"id": "10109"}. Find one with artg_search.');
  }
  const url = new URL(`${BASE}/ARTGValueSearch/`);
  url.searchParams.set('licenceid', id);
  url.searchParams.set('pagestart', '1');
  url.searchParams.set('pageend', '5');

  const data = await artgSearch(url);
  const rows = data.Results ?? [];
  if (!rows.length) {
    return notFound('artg_id_not_found', `No ARTG entry with id "${id}". Find a valid one with artg_search.`, { id, source_url: url.toString() });
  }
  const r = rows[0];
  const products = (r.Products ?? []).map((p) => ({
    name: p.Name ?? null,
    ingredients: (p.Ingredients ?? []).map((i) => ({
      name: (i.Name ?? '').trim(),
      strength: i.Strength || null,
      formulation_type: i.FormulationType ?? null,
    })),
    dosage_form: p.Components?.[0]?.DosageForm ?? null,
    route_of_administration: p.Components?.[0]?.RouteOfAdministration ?? null,
    standard_indications: p.StandardIndications ?? [],
    specific_indications: p.SpecificIndications ?? [],
  }));
  return {
    ...provenance(url),
    artg_id: r.LicenceId ?? null,
    name: r.Name ?? null,
    entry_type: r.EntryType ?? null,
    product_category: r.ProductCategory ?? null,
    status: r.Status || 'unknown', // never guessed: absent upstream → 'unknown'
    start_date: r.StartDate ?? null,
    sponsor: r.Sponsor?.Name ?? null,
    products,
    pi_document_url: r.ProductInformation?.DocumentLink || null, // Product Information (prescriber label)
    cmi_document_url: r.ConsumerInformation?.DocumentLink || null, // Consumer Medicine Information (patient leaflet)
  };
}

// ---- tool defs ----------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'artg_search',
    description:
      'Search the Australian Register of Therapeutic Goods (ARTG) — every medicine, biological and medical device approved for supply in Australia — by product name, active ingredient, sponsor, or manufacturer. Returns each entry\'s ARTG ID, entry type (e.g. "Medicine Registered", "Medicine Listed"), sponsor, active ingredients, status, and links to its Product Information (PI, prescriber label) and Consumer Medicine Information (CMI, patient leaflet) documents. Answers "is X approved in Australia", "which Australian products contain ibuprofen", "who sponsors X in Australia". This calls the TGA\'s own JSON web service directly (data.tga.gov.au) rather than the interactive ARTG Search web tool. Paged: the response carries total, has_more and next_offset — pass offset to fetch the next page. Example: artg_search({ ingredient: "paracetamol" }); artg_search({ ingredient: "amoxicillin", offset: 100 }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Product/trade name, e.g. "Panadol"' },
        ingredient: { type: 'string', description: 'Active ingredient, e.g. "paracetamol", "ibuprofen"' },
        product: { type: 'string', description: 'Product name fragment (device/product-level, distinct from name)' },
        sponsor: { type: 'string', description: 'Sponsor (marketing-authorisation holder) name, e.g. "Pfizer"' },
        manufacturer: { type: 'string', description: 'Manufacturer name' },
        entry_type: { type: 'string', description: 'Restrict to an ARTG entry type; matches its start, e.g. "Medicine", "Medicine Registered", "Medicine Listed", "Biological", "Medical Device"' },
        limit: { type: 'number', description: 'Max entries to return (default 25, max 100)' },
        offset: { type: 'number', description: 'Number of matching entries to skip (0-based). Use next_offset from the previous response to page.' },
      },
    },
  },
  {
    name: 'artg_entry',
    description:
      'Full Australian Register of Therapeutic Goods (ARTG) record for one entry, by ARTG ID (LicenceId, from artg_search). Returns sponsor, every active/excipient ingredient with strength, dosage form, route of administration, standard/specific indications, status and start date, and links to the Product Information (PI) and Consumer Medicine Information (CMI) documents. Example: artg_entry({ id: "10109" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ARTG number (LicenceId), e.g. "10109"' } },
      required: ['id'],
    },
  },
  {
    name: 'artg_list',
    description:
      'Walk the ENTIRE Australian Register of Therapeutic Goods (ARTG), in ARTG ID order, 100 entries per page — for bulk ingestion or counting, not for answering a question about one drug (use artg_search for that). Optionally restrict to one entry type ("Medicine Registered" ≈ 20,000 prescription/registered medicines; "Medicine" ≈ 34,000 incl. listed). Returns total, has_more and next_offset; pass offset to continue. Each row carries ARTG ID, name, entry type, sponsor, active ingredients, status, start date and PI/CMI links; use artg_entry for indications. Example: artg_list({ entry_type: "Medicine Registered", offset: 0 }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_type: { type: 'string', description: 'Restrict to an ARTG entry type; matches its start, e.g. "Medicine", "Medicine Registered", "Medical Device". Omit for the whole register.' },
        offset: { type: 'number', description: 'Entries to skip (0-based). Use next_offset from the previous page.' },
        limit: { type: 'number', description: 'Entries per page (default and max 100)' },
      },
    },
  },
  {
    name: 'artg_recent',
    description:
      'New entries added to the Australian Register of Therapeutic Goods (ARTG) since a date — newly registered or listed medicines, biologicals and devices approved for supply in Australia. Covers NEW entries only: cancellations and variations to existing entries are not dated by the source and are not reported. Scans the newest ~500 entries; reports complete=false if the date is further back than that. Example: artg_recent({ since: "2026-09-15", entry_type: "Medicine" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO date (YYYY-MM-DD); entries whose start date is on or after it' },
        entry_type: { type: 'string', description: 'Restrict to an ARTG entry type, e.g. "Medicine", "Medicine Registered"' },
      },
      required: ['since'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'artg_search': return search(args);
    case 'artg_entry': return entry(args);
    case 'artg_list': return list(args);
    case 'artg_recent': return recent(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
