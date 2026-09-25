# @pipeworx/tga-artg

TGA ARTG — the Australian Register of Therapeutic Goods: every medicine, biological and medical device approved for supply in **Australia**. Search by product, active ingredient, sponsor or manufacturer, or pull the full record for one ARTG entry — sponsor, every ingredient with strength, indications, and links to its Product Information (PI) and Consumer Medicine Information (CMI) documents.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1681+ live data sources.

## Scope — Australia, and only Australia

For the US use `openfda`; EU-wide, `ema-medicines`; UK, `mhra-uk`; Canada, `health-canada-drugs`; Spain, `aemps-cima`. Tools are prefixed `artg_` so they never win a generic drug question.

## Tools

| Tool | Answers |
|---|---|
| `artg_search` | *Which Australian products contain ibuprofen?* — search by name/ingredient/sponsor/manufacturer |
| `artg_entry` | *What is ARTG 10109?* — full ingredients, indications, PI/CMI links |
| `artg_list` | *Give me every registered medicine in Australia* — walks the whole register (or one entry type) in ARTG-ID order, 100 per page, with `total` / `next_offset` |
| `artg_recent` | *What was added to the ARTG since 2026-09-15?* — new entries only (see below) |

Every response carries `source_url` (the exact upstream request) and `data_as_of` (fetch time — this is a live proxy, so there is no separate published version). `status` is the register's own value, or `unknown` when the source omits it; it is never inferred.

## Paging and enumeration

`artg_search` and `artg_list` take a 0-based `offset` and return `total`, `has_more` and `next_offset`, taken from the upstream's own `TotalRecords` — so paging is exact, not inferred from a full page. Measured 2026-09-25: the whole register is 97,087 entries; `entry_type: "Medicine Registered"` is 20,037, `"Medicine"` 34,379. A full sweep of registered medicines is ~201 calls.

Arguments a tool does not implement are **refused with an error**, not ignored. Until fleet #2422 `offset` was accepted and silently dropped, so an enumeration loop re-read page one forever and reported success.

## Auth

Keyless. No registration.

## Data source — NOT the documented "ARTG Search" tool

- <https://data.tga.gov.au/ARTGSearch/ARTGWebService.svc/JSON/ARTGValueSearch/> — the WCF JSON web service that actually backs the register.

The TGA's own documented ARTG Search tool — linked from tga.gov.au and, as of 2026, a beta Power Apps/Power BI portal at `compliance.health.gov.au/artg` — is **interactive-only**: a rendered visual with no query API behind it. `tga.gov.au` itself is also unreachable from our egress (its Akamai front end times out on every request, including a bare static PDF — a silent connection hold, not a 403). This pack instead calls the JSON web service that genuinely backs the register, at the separate, reachable host `data.tga.gov.au` — the same service TGA's own internal client library (`aehrc/tga-feed-client` on GitHub) is built against. It is keyless, live, and answers per query — a proxy, not a mirror.

### Things the next person would otherwise rediscover

- **The path segment must be uppercase `JSON`.** Lowercase `json` (the form quoted in most third-party documentation, including the aehrc client's own example config) 404s with a generic WCF "Endpoint not found" HTML page — which is a `200`-shaped failure if you don't check for an HTML body where JSON was expected. This pack throws explicitly if the response starts with `<`.
- **`pagestart`/`pageend` are a 1-indexed, INCLUSIVE RECORD RANGE, not a page number.** `pagestart=3&pageend=5` returns records 3, 4 and 5 (three rows). Omitting both silently returns the **entire ARTG register** (25,000+ active entries) in ARTG-ID order, ignoring every other filter — every call here sends an explicit `pagestart=1`/`pageend=<limit>`.
- **`ARTGValueSearch` filtered by `licenceid` alone returns the single full record** — there is no separate working lookup-by-ID endpoint on this host (`ARTGEntryJson` 404s), so `artg_entry` is built on the same search operation with `licenceid` as the only filter.
- **`dateStart`/`dateEnd` are in the service's WSDL and do nothing.** Probed 2026-09-25 with ISO and dd/mm/yyyy formats, alone and with other filters: the total never changes. So `artg_recent` walks back from the tail of the ID-ordered register instead (IDs are issued sequentially; the newest entries are last) and stops at the first page entirely before `since`, scanning at most 500 entries and saying `complete: false` if that was not enough. It sees NEW entries only — a cancellation or variation to an existing entry carries no date here.
- **Large ranges are slow.** 500 rows took 34s on 2026-09-25; pages are capped at 100.
- **`www.tga.gov.au` is unreachable from our network — do not build against it.** `data.tga.gov.au` (a distinct host, no Akamai) is what actually answers.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "tga-artg": {
      "url": "https://gateway.pipeworx.io/tga-artg/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/tga-artg/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1681+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/artg_search \
  -H 'Content-Type: application/json' \
  -d '{"ingredient":"paracetamol","limit":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/artg_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "tga-artg": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-tga-artg"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-tga-artg
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Tga Artg data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
