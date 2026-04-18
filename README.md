# Multi-Source Tech Intelligence Search

Search 18 tech sources in one API call and get structured JSON results. Built for developers, analysts, and AI agents who need real-time tech intelligence without juggling multiple APIs.

## What does Multi-Source Tech Intelligence Search do?

Multi-Source Tech Intelligence Search queries **Hacker News, GitHub, npm, PyPI, Product Hunt, X/Twitter, Dev.to, Hashnode, ArXiv, Reddit, YouTube, StackExchange, Lobste.rs, Zenn, Qiita, Semantic Scholar, Lemmy, and GitLab** simultaneously and returns unified, structured JSON. Instead of writing separate integrations for each platform, you make one request and get normalized results with relevance scores, metadata, and direct links.

Use it for:
- **Competitive intelligence** — track what competitors are building and launching
- **Trend monitoring** — spot emerging technologies before they go mainstream
- **Market research** — understand developer sentiment and adoption patterns
- **Due diligence** — quickly assess a technology's ecosystem health

## Why use Multi-Source Tech Intelligence Search?

- **18 sources, 1 call** — HN, GitHub, npm, PyPI, Product Hunt, X/Twitter, Dev.to, Hashnode, ArXiv, Reddit, YouTube, StackExchange, Lobste.rs, Zenn, Qiita, Semantic Scholar, Lemmy, and GitLab
- **Structured output** — consistent JSON schema across all sources
- **Pay-per-use** — no subscription, pay only for what you search
- **Real-time data** — live API queries, not cached or stale data
- **Partial failure tolerance** — if one source is down, others still return results
- **AI-powered X search** — uses xAI's Grok model for intelligent Twitter/X results

## How much does it cost?

This Actor uses **Pay Per Event** pricing — you only pay for searches you actually run.

| What you get | Price per call | Event name |
|---|---|---|
| Search one free source (HN, GitHub, npm, PyPI, Product Hunt, Dev.to, Hashnode, ArXiv, Reddit, YouTube, StackExchange, Lobste.rs, Zenn, Qiita, Semantic Scholar, Lemmy, GitLab) | **$0.005** | `search-free` |
| Search X/Twitter (AI-powered via xAI Grok) | **$0.20** | `search-x` |
| Balanced report (14 free sources in parallel) | **$0.005** | `report-balanced` |
| Comprehensive report (all 18 sources including X) | **$0.25** | `report-full` |

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
  "sources_queried": ["hn", "github", "npm", "pypi", "devto", "hashnode", "lobsters", "stackoverflow", "arxiv", "zenn", "qiita", "scholar", "lemmy", "gitlab"],
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
curl "https://scout.hugen.tokyo/scout/hn?q=AI+agents&per_page=5"

# Search GitHub repositories
curl "https://scout.hugen.tokyo/scout/github?q=mcp+server&sort=stars&per_page=10"

# Search npm packages
curl "https://scout.hugen.tokyo/scout/npm?q=openai&per_page=10"

# Search X/Twitter (AI-powered)
curl "https://scout.hugen.tokyo/scout/x?q=x402+protocol&per_page=10"
```

### Multi-source reports

```bash
# Balanced report (14 free sources)
curl "https://scout.hugen.tokyo/scout/report?q=MCP+servers&per_page=5"

# Comprehensive report (all 18 sources including X)
curl "https://scout.hugen.tokyo/scout/report/full?q=AI+agents&per_page=5"
```

### Available endpoints

| Endpoint | Source | Price |
|---|---|---|
| `/scout/hn` | Hacker News (Algolia) | $0.005 |
| `/scout/github` | GitHub Repositories | $0.005 |
| `/scout/npm` | npm Registry | $0.005 |
| `/scout/pypi` | PyPI Packages | $0.005 |
| `/scout/ph` | Product Hunt | $0.005 |
| `/scout/x` | X/Twitter (xAI Grok) | $0.20 |
| `/scout/devto` | Dev.to | $0.005 |
| `/scout/hashnode` | Hashnode | $0.005 |
| `/scout/arxiv` | ArXiv | $0.005 |
| `/scout/reddit` | Reddit | $0.005 |
| `/scout/youtube` | YouTube | $0.005 |
| `/scout/stackoverflow` | StackExchange | $0.005 |
| `/scout/lobsters` | Lobste.rs | $0.005 |
| `/scout/zenn` | Zenn | $0.005 |
| `/scout/qiita` | Qiita | $0.005 |
| `/scout/scholar` | Semantic Scholar | $0.005 |
| `/scout/lemmy` | Lemmy | $0.005 |
| `/scout/gitlab` | GitLab | $0.005 |
| `/scout/report` | Balanced (14 sources) | $0.005 |
| `/scout/report/full` | Comprehensive (18 sources) | $0.25 |
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
