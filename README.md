# Multi-Source Tech Intelligence Search

Search 6+ tech sources in one API call and get structured JSON results. Built for developers, analysts, and AI agents who need real-time tech intelligence without juggling multiple APIs.

## What does Multi-Source Tech Intelligence Search do?

Multi-Source Tech Intelligence Search queries **Hacker News, GitHub, npm, PyPI, Product Hunt, and X/Twitter** simultaneously and returns unified, structured JSON. Instead of writing separate integrations for each platform, you make one request and get normalized results with relevance scores, metadata, and direct links.

Use it for:
- **Competitive intelligence** — track what competitors are building and launching
- **Trend monitoring** — spot emerging technologies before they go mainstream
- **Market research** — understand developer sentiment and adoption patterns
- **Due diligence** — quickly assess a technology's ecosystem health

## Why use Multi-Source Tech Intelligence Search?

- **6 sources, 1 call** — HN, GitHub, npm, PyPI, Product Hunt, and X/Twitter
- **Structured output** — consistent JSON schema across all sources
- **Pay-per-use** — no subscription, pay only for what you search
- **Real-time data** — live API queries, not cached or stale data
- **Partial failure tolerance** — if one source is down, others still return results
- **AI-powered X search** — uses xAI's Grok model for intelligent Twitter/X results

## How much does it cost?

This Actor uses **Pay Per Event** pricing — you only pay for searches you actually run.

| What you get | Price per call | Event name |
|---|---|---|
| Search one free source (HN, GitHub, npm, PyPI, Product Hunt, or Bazaar) | **$0.005** | `search-free` |
| Search X/Twitter (AI-powered via xAI Grok) | **$0.10** | `search-x` |
| Balanced report (4 free sources in parallel) | **$0.02** | `report-balanced` |
| Comprehensive report (all 6 sources including X) | **$0.15** | `report-full` |

**Example**: Running 100 balanced reports costs just $2.00.

## Input

All endpoints accept query parameters via HTTP GET:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | Yes | Search query |
| `per_page` | number | No | Results per source (default: 10, max: 50) |
| `sort` | string | No | Sort order (source-specific) |
| `focus` | string | No | Report preset: `balanced` or `comprehensive` |
| `sources` | string | No | Comma-separated source list for reports |

## Output

Every response follows a consistent structure:

```json
{
  "success": true,
  "source": "hackernews",
  "query": "AI agents",
  "count": 10,
  "data": [
    {
      "title": "Show HN: Open-source AI agent framework",
      "url": "https://news.ycombinator.com/item?id=...",
      "points": 342,
      "num_comments": 128,
      "created_at": "2026-02-20T10:30:00Z"
    }
  ]
}
```

Report endpoints return results grouped by source:

```json
{
  "success": true,
  "query": "MCP servers",
  "focus": "balanced",
  "sources_queried": ["hn", "github", "npm", "pypi"],
  "results": {
    "hn": { "success": true, "count": 10, "data": [...] },
    "github": { "success": true, "count": 10, "data": [...] },
    "npm": { "success": true, "count": 10, "data": [...] },
    "pypi": { "success": true, "count": 5, "data": [...] }
  }
}
```

## How to use

This Actor runs in **Standby mode** — it's always available as an HTTP API.

### Individual source search

```bash
# Search Hacker News
curl "https://gen-ishinabe--scout-multi-source-search.apify.actor/scout/hn?q=AI+agents&per_page=5" \
  -H "Authorization: Bearer YOUR_APIFY_TOKEN"

# Search GitHub repositories
curl "https://gen-ishinabe--scout-multi-source-search.apify.actor/scout/github?q=mcp+server&sort=stars&per_page=10" \
  -H "Authorization: Bearer YOUR_APIFY_TOKEN"

# Search npm packages
curl "https://gen-ishinabe--scout-multi-source-search.apify.actor/scout/npm?q=openai&per_page=10" \
  -H "Authorization: Bearer YOUR_APIFY_TOKEN"

# Search X/Twitter (AI-powered)
curl "https://gen-ishinabe--scout-multi-source-search.apify.actor/scout/x?q=x402+protocol&per_page=10" \
  -H "Authorization: Bearer YOUR_APIFY_TOKEN"
```

### Multi-source reports

```bash
# Balanced report (4 free sources)
curl "https://gen-ishinabe--scout-multi-source-search.apify.actor/scout/report?q=MCP+servers&per_page=5" \
  -H "Authorization: Bearer YOUR_APIFY_TOKEN"

# Comprehensive report (all 6 sources including X)
curl "https://gen-ishinabe--scout-multi-source-search.apify.actor/scout/report/full?q=AI+agents&per_page=5" \
  -H "Authorization: Bearer YOUR_APIFY_TOKEN"
```

### Available endpoints

| Endpoint | Source | Price |
|---|---|---|
| `/scout/hn` | Hacker News (Algolia) | $0.005 |
| `/scout/github` | GitHub Repositories | $0.005 |
| `/scout/npm` | npm Registry | $0.005 |
| `/scout/pypi` | PyPI Packages | $0.005 |
| `/scout/ph` | Product Hunt | $0.005 |
| `/scout/x402` | x402 Bazaar | $0.005 |
| `/scout/x` | X/Twitter (xAI Grok) | $0.10 |
| `/scout/report` | Balanced (4 sources) | $0.02 |
| `/scout/report/full` | Comprehensive (6 sources) | $0.15 |
| `/health` | Health check | Free |

## Integrations

- **Direct HTTP API** — use from any language with HTTP support
- **Apify API client** — use the official [Apify SDK](https://docs.apify.com/api/client/js/) for Node.js or Python
- **Zapier / Make / n8n** — connect via Apify's built-in integrations
- **AI agents** — structured JSON output is optimized for LLM consumption

## Limitations

- **X/Twitter search uses AI** — results come from xAI's Grok model with web search, so structure may occasionally vary
- **PyPI search is name-based** — searches by package name variants, not full-text keyword search
- **Product Hunt is topic-based** — queries are mapped to PH topic slugs; niche queries may return fewer results
- **Rate limits** — GitHub allows ~30 requests/minute with authentication; heavy concurrent use may hit limits
- **Cold start** — first request after idle period takes 15-20 seconds; subsequent requests are sub-second
