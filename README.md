# scout-mcp

An MCP server that searches 21 platforms in parallel and returns structured JSON. Built with the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk).

Connect it to Claude Desktop, VS Code, Cursor, or any MCP client and search code registries, academic papers, social platforms, and tech blogs from a single tool call.

## Tools

| Tool | Source | Notes |
|------|--------|-------|
| `hackernews_search` | Hacker News (Algolia) | Stories, comments, polls |
| `github_search` | GitHub | Repositories by keyword |
| `github_repo_info` | GitHub | Single repo details |
| `npm_search` | npm Registry | Packages |
| `pypi_search` | PyPI | Python packages |
| `producthunt_search` | Product Hunt | Products by topic |
| `x_search` | X / Twitter | AI-powered via xAI Grok (requires `XAI_API_KEY`) |
| `devto_search` | Dev.to | Articles |
| `hashnode_search` | Hashnode | Articles (GraphQL) |
| `lobsters_search` | Lobste.rs | Stories |
| `stackexchange_search` | StackExchange | Q&A across all sites |
| `arxiv_search` | ArXiv | Academic papers |
| `reddit_search` | Reddit | Posts and comments |
| `youtube_search` | YouTube | Videos (requires `YOUTUBE_API_KEY`) |
| `zenn_search` | Zenn | Japanese tech articles |
| `qiita_search` | Qiita | Japanese tech articles |
| `semantic_scholar_search` | Semantic Scholar | Academic papers |
| `lemmy_search` | Lemmy | Fediverse posts |
| `gitlab_search` | GitLab | Projects |
| `bazaar_search` | x402 Bazaar | x402 API directory |
| `scout_report` | Multi-source | Parallel search across selected sources |

## Quick start

### Claude Desktop / VS Code

Add to your MCP client config:

```json
{
  "mcpServers": {
    "scout": {
      "command": "npx",
      "args": ["-y", "scout-cli"]
    }
  }
}
```

### Docker

```bash
docker build -t scout-mcp .
docker run -i scout-mcp
```

The Dockerfile builds a minimal `node:24-alpine` image that runs the MCP server over stdio.

### From source

```bash
git clone https://github.com/bartonguestier1725-collab/scout-mcp.git
cd scout-mcp
npm install
npm run build
node build/index.js
```

## Configuration

All configuration is via environment variables. Most tools work without any keys. Optional keys unlock additional sources or raise rate limits.

| Variable | Required | Description |
|----------|----------|-------------|
| `XAI_API_KEY` | For `x_search` | xAI API key for X/Twitter search |
| `GITHUB_TOKEN` | Recommended | Raises GitHub rate limit |
| `YOUTUBE_API_KEY` | For `youtube_search` | YouTube Data API v3 key |
| `PH_CLIENT_ID` / `PH_CLIENT_SECRET` | For `producthunt_search` | Product Hunt API credentials |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | For `reddit_search` | Reddit API credentials |
| `QIITA_TOKEN` | Optional | Raises Qiita rate limit |
| `S2_API_KEY` | Optional | Semantic Scholar dedicated rate limit |
| `SE_API_KEY` | Optional | StackExchange dedicated rate limit |

## How it works

Each tool makes a direct API call to its source, parses the response, and returns normalized JSON with consistent fields (`title`, `url`, `source`, `created_at`, etc.). The `scout_report` tool runs multiple searches in parallel using `Promise.allSettled`, so one source failing doesn't block the others.

Transport: **stdio** (standard MCP transport). The server reads JSON-RPC messages from stdin and writes responses to stdout.

## HTTP mode

scout-mcp also runs as a paid HTTP API at `https://scout.hugen.tokyo` via the [x402 protocol](https://x402.org) (USDC micropayments on Base). This mode uses the same tool implementations but exposes them as REST endpoints with payment middleware.

## License

Proprietary. Source code is provided for transparency and MCP client compatibility evaluation.
