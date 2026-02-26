# scout-mcp — マルチソース情報偵察 MCP サーバー

## これは何？

Claude Code からツール呼び出しで使える **情報偵察（スカウト）MCP サーバー**。
X(Twitter), GitHub, Hacker News, Product Hunt, npm, PyPI, x402 Bazaar を横断検索し、
技術トレンド・競合・マーケット情報を構造化 JSON で返す。

**x402 HTTP API としても公開中**: `https://scout.hugen.tokyo`（USDC on Base）

---

## 設計思想

1. **デュアルモード** — MCP (stdio) + HTTP (Express + x402) の2モードで同じツール群を共有
2. **最小依存** — `@modelcontextprotocol/sdk`, `zod`, `dotenv`, `express`, `@x402/*`
3. **個別ツール + 合成レポート** — 9 ツールが独立動作し、`scout_report` が並列合成する
4. **x402 マイクロペイメント** — $0.001/req (無料ソース) 〜 $0.05/req (X含む)
5. **1 ソース失敗 ≠ 全滅** — `Promise.allSettled` で部分的成功を許容

---

## プロジェクト構造

```
scout-mcp/
├── package.json
├── tsconfig.json
├── .env                   # API キー + x402 設定（git 管理外）
├── .env.example           # テンプレート
├── .gitignore
├── CLAUDE.md              # ← このファイル
├── self_pay.py            # Bazaar セルフペイスクリプト
├── src/
│   ├── index.ts           # MCP サーバーエントリ (StdioServerTransport)
│   ├── server.ts          # HTTP サーバー (Express + x402 ミドルウェア)
│   ├── cli.ts             # テスト CLI (node build/cli.js <tool> '<json>')
│   ├── config.ts          # 環境変数・定数・デフォルト値
│   ├── fetch-utils.ts     # safeFetch (timeout/abort/error handling)
│   ├── types.ts           # ToolResult, ScoutError, ok(), fail()
│   └── tools/
│       ├── x-search.ts             # X 検索 (xAI Grok API)
│       ├── hackernews-search.ts    # HN 検索 (Algolia API)
│       ├── npm-search.ts           # npm Registry 検索
│       ├── github-search.ts        # GitHub リポ検索
│       ├── github-repo-info.ts     # GitHub リポ詳細
│       ├── pypi-search.ts          # PyPI パッケージ検索
│       ├── producthunt-search.ts   # Product Hunt 検索 (GraphQL)
│       ├── bazaar-search.ts        # x402 Bazaar 検索 (CDP Discovery)
│       ├── devto-search.ts         # Dev.to 記事検索 (Forem API)
│       ├── hashnode-search.ts      # Hashnode 記事検索 (GraphQL)
│       ├── lobsters-search.ts      # Lobste.rs 検索 (JSON API)
│       ├── stackexchange-search.ts # StackExchange 検索 (API v2.3)
│       ├── arxiv-search.ts         # ArXiv 論文検索 (Atom API)
│       ├── reddit-search.ts        # Reddit 検索 (.json feeds, MCP限定)
│       ├── youtube-search.ts       # YouTube 検索 (Data API v3)
│       ├── zenn-search.ts          # Zenn 記事検索 (非公式API, MCP限定)
│       ├── qiita-search.ts         # Qiita 記事検索 (API v2, MCP限定)
│       ├── semantic-scholar-search.ts # Semantic Scholar 論文検索
│       ├── lemmy-search.ts         # Lemmy 検索 (Fediverse, MCP限定)
│       ├── gitlab-search.ts        # GitLab プロジェクト検索
│       └── scout-report.ts         # 複合レポート (並列実行)
└── build/                 # tsc 出力（git 管理外）
```

---

## 技術スタック

- **Runtime**: Node.js 24 (built-in fetch)
- **Language**: TypeScript (ES2022, Node16 module resolution)
- **MCP SDK**: `@modelcontextprotocol/sdk` v1.26
- **Schema**: zod v4
- **Transport**: stdio（MCP モード） / HTTP（x402 モード）
- **x402**: `@x402/express`, `@x402/core`, `@x402/evm`, `@x402/extensions`
- **HTTP**: Express 5

---

## ツール一覧

| # | ツール名 | ソース | 認証 | コスト | 状態 |
|---|----------|--------|------|--------|------|
| 1 | `x_search` | xAI Grok API | XAI_API_KEY 必須 | ~$0.005/回 | 動作確認済 |
| 2 | `hackernews_search` | HN Algolia API | 不要 | 無料 | 動作確認済 |
| 3 | `npm_search` | npm Registry API | 不要 | 無料 | 動作確認済 |
| 4 | `github_search` | GitHub REST API | GITHUB_TOKEN 設定済 | 無料 | 動作確認済 |
| 5 | `github_repo_info` | GitHub REST API | GITHUB_TOKEN 設定済 | 無料 | ビルド確認済 |
| 6 | `pypi_search` | PyPI JSON API | 不要 | 無料 | 動作確認済 |
| 7 | `producthunt_search` | PH GraphQL API | PH_CLIENT_* 必須 | 無料 | 動作確認済 |
| 8 | `bazaar_search` | CDP Discovery API | 不要 | 無料 | 動作確認済 |
| 9 | `devto_search` | Dev.to Forem API | 不要 | 無料 | 動作確認済 |
| 10 | `hashnode_search` | Hashnode GraphQL | 不要 | 無料 | 動作確認済 |
| 11 | `lobsters_search` | Lobste.rs JSON | 不要 | 無料 | 動作確認済 |
| 12 | `stackexchange_search` | SE API v2.3 | SE_API_KEY 任意 | 無料 | 動作確認済 |
| 13 | `arxiv_search` | ArXiv Atom API | 不要 | 無料 | 動作確認済 |
| 14 | `reddit_search` | Reddit .json feeds | 不要 | 無料 | MCP限定 |
| 15 | `youtube_search` | YouTube Data API v3 | YOUTUBE_API_KEY 必須 | 無料 | MCP限定 |
| 16 | `zenn_search` | Zenn 非公式 API | 不要 | 無料 | MCP限定 |
| 17 | `qiita_search` | Qiita API v2 | QIITA_TOKEN 任意 | 無料 | MCP限定 |
| 18 | `semantic_scholar_search` | Semantic Scholar API | S2_API_KEY 任意 | 無料 | 動作確認済 |
| 19 | `lemmy_search` | Lemmy API v3 | 不要 | 無料 | MCP限定 |
| 20 | `gitlab_search` | GitLab API v4 | 不要 | 無料 | 動作確認済 |
| 21 | `scout_report` | 上記を並列合成 | 各ソースに依存 | X 使用時課金 | 動作確認済 |

### scout_report の focus プリセット

| focus | 使うソース |
|-------|-----------|
| `balanced` (デフォルト) | HN, GitHub, npm, PyPI, Dev.to, Hashnode, Lobsters, StackExchange, ArXiv, Zenn, Qiita, Semantic Scholar, Lemmy, GitLab（14ソース） |
| `trending` | HN, X, Product Hunt, Dev.to, Lobsters（5ソース） |
| `comprehensive` | 全 18 ソース |

---

## テスト時の注意

X 検索 (`x_search`) は xAI API 呼び出しで 1 回 ~$0.005 かかる。
開発・デバッグ中は X 以外のツールでテストし、X のテストはリリース前の最終確認で行う。

```bash
# 無料ソースでテスト
node build/cli.js hackernews_search '{"query":"test","per_page":3}'
node build/cli.js github_search '{"query":"x402","sort":"stars","per_page":3}'
node build/cli.js npm_search '{"query":"mcp","per_page":3}'
node build/cli.js pypi_search '{"query":"fastapi"}'
node build/cli.js scout_report '{"query":"MCP","sources":["hn","github","npm"]}'
```

---

## 開発ルール

### ビルド

```bash
npm run build       # TypeScript → build/
npm run dev         # watch モード
```

### stdout は MCP プロトコル専用

**`console.log()` 禁止**。デバッグは `console.error()` のみ。
stdout に 1 バイトでもゴミを流すと JSON-RPC が壊れる。

### 各ツールのパターン

- `execute(args)` — 直接実行可能な関数。常に `ToolResult` を返す（例外を投げない）
- `register(server)` — MCP サーバーにツール登録
- API キー未設定時は `{ success: false, error: "... not configured" }` を返す（crash しない）

### エラーハンドリング

- `execute()` は **例外を投げない**。常に `ToolResult` で `success: false` を返す
- `safeFetchJson / safeFetchText` で HTTP エラーを `ScoutError` に変換
- `scout_report` は `Promise.allSettled` で個別失敗を吸収

---

## 環境変数 (.env)

| 変数 | 必要度 | 説明 |
|------|--------|------|
| `XAI_API_KEY` | x_search に必須 | xAI Grok API キー。~$0.005/リクエスト |
| `GITHUB_TOKEN` | 設定済 | GitHub API レート制限緩和 (10→30 req/min) |
| `PH_CLIENT_ID` | PH に必須 | Product Hunt Developer App 用 |
| `PH_CLIENT_SECRET` | PH に必須 | Product Hunt Developer App 用 |
| `SE_API_KEY` | 任意 | StackExchange レート制限緩和 (300→10K req/day) |
| `YOUTUBE_API_KEY` | youtube に必須 | YouTube Data API v3 キー |
| `QIITA_TOKEN` | 任意 | Qiita レート制限緩和 (60→1000 req/h) |
| `S2_API_KEY` | 任意 | Semantic Scholar dedicated レート (shared→1 req/sec) |

---

## Claude Code への登録

`.claude.json` の `mcpServers` に登録済み:
```json
{
  "scout-mcp": {
    "command": "node",
    "args": ["/home/gen/projects/scout-mcp/build/index.js"]
  }
}
```

次回セッションで `/mcp` → scout-mcp が connected なら成功。

---

## x402 HTTP API（本番稼働中）

### デプロイ情報

| 項目 | 値 |
|------|----|
| URL | `https://scout.hugen.tokyo` |
| ポート | 4023 |
| systemd | `x402-scout.service`（カスタム、テンプレート不使用） |
| env | `~/etc/x402/scout.env` |
| トンネル | `~/.cloudflared/config.yml` の ingress |
| 受取アドレス | `0x29322Ea7EcB34aA6164cb2ddeB9CE650902E4f60` |
| ネットワーク | `eip155:8453`（Base Mainnet） |
| Facilitator | CDP（@coinbase/x402 公式ヘルパーで JWT 認証） |

### HTTP エンドポイント

| Route | 価格 | ツール |
|-------|------|--------|
| `GET /health` | Free | — |
| `GET /.well-known/x402` | Free | — |
| `GET /scout/hn?q=` | $0.001 | hackernews_search |
| `GET /scout/npm?q=` | $0.001 | npm_search |
| `GET /scout/github?q=` | $0.001 | github_search |
| `GET /scout/github/repo?owner=&repo=` | $0.001 | github_repo_info |
| `GET /scout/pypi?q=` | $0.001 | pypi_search |
| `GET /scout/ph?q=` | $0.001 | producthunt_search |
| `GET /scout/x?q=` | $0.20 | x_search |
| `GET /scout/x402?q=` | $0.001 | bazaar_search |
| `GET /scout/devto?q=` | $0.001 | devto_search |
| `GET /scout/hashnode?q=` | $0.001 | hashnode_search |
| `GET /scout/lobsters?q=` | $0.001 | lobsters_search |
| `GET /scout/stackoverflow?q=` | $0.001 | stackexchange_search |
| `GET /scout/arxiv?q=` | $0.001 | arxiv_search |
| `GET /scout/scholar?q=` | $0.001 | semantic_scholar_search |
| `GET /scout/gitlab?q=` | $0.001 | gitlab_search |
| `GET /scout/report?q=` | $0.001 | scout_report (balanced, 14ソース) |
| `GET /scout/report/full?q=` | $0.25 | scout_report (comprehensive, 18ソース) |
| `GET /openapi.json` | Free | OpenAPI 3.0 spec |

### 棚置き状況（2026-02-24 v0.3.0 更新）

| プラットフォーム | 状態 |
|----------------|------|
| x402 Bazaar | ✅ 17 EP（selfpay 15EP + X/report-full は除外。cron週次自動更新） |
| x402scan | ✅ 17 EP（discovery 自動で価格反映） |
| ClawMart | ✅ 19 EP (#398-407, #419-420, #424-430) |
| awesome-x402 | ✅ PR #33 Merged (gotobi+weather), PR #38 Merged (scout) |
| x402 Index | ✅ 提出済み |
| **Apify Store** | ✅ 公開済み（PPE 4イベント） |
| RelAI | ⏸ **凍結**（エラー頻発） |
| Apiosk | ⏸ **凍結**（手動ポチポチ面倒） |

### サービス管理

```bash
# 起動・停止
systemctl --user start x402-scout
systemctl --user stop x402-scout
systemctl --user restart x402-scout

# ログ
journalctl --user -u x402-scout -f

# ビルド + 再起動
npm run build && systemctl --user restart x402-scout
```

### 将来計画

### 追加ソース候補（実装済み → 上のツール一覧参照）
- ✅ Reddit, Dev.to, Hashnode, ArXiv, StackExchange, Lobste.rs, YouTube（v0.2.0）
- ✅ Zenn, Qiita, Semantic Scholar, Lemmy, GitLab（v0.3.0）
- Mastodon（Fediverse 系、将来候補）

### 価格設定と xAI コスト監視

**価格は env 変数で即時変更可能**（コード変更・ビルド不要）:

```bash
# ~/etc/x402/scout.env または .env に追加
PRICE_X=$0.20         # /scout/x の価格
PRICE_XFULL=$0.25     # /scout/report/full の価格
PRICE_LOW=$0.001      # その他の価格
XAI_COST_PER_CALL=0.05  # xAI 平均コスト（2026-02-22 ダッシュボード実測確定）
```

変更後: `systemctl --user restart x402-scout`

**コスト監視**: `/health` エンドポイントに `xai_cost_health` セクションあり:
- `avg_cost_per_call`: xAI API の実測平均コスト
- `margin_pct`: 現在のマージン率（%）
- `alert`: マージンが 40% 未満で `true`（値上げ対応が必要）
- x402-monitor weekly が自動チェック → Discord アラート

---

## 既知の制限事項

1. **PyPI 検索はパッケージ名ベース** — PyPI Web 検索が Cloudflare bot 対策で保護されているため、パッケージ名候補を生成して JSON API で直接 lookup する方式。キーワード検索には弱い
2. **PyPI 障害と 0 件の区別不可（既知の運用リスク）** — `pypi_search` は候補 lookup の失敗（404 も 5xx も）を全て null に潰すため、PyPI API 障害時も `success: true, count: 0` を返す。scout_report 側で障害と 0 件を区別できない。次フェーズで 404 のみ null、その他は fail に分離する予定
3. **X 検索は LLM 経由** — xAI の Responses API (grok-4-1-fast-non-reasoning) + web_search で X を検索するため、レスポンスの構造が不安定なことがある。`tool_choice: "required"` で web search を強制し、JSON パース失敗時は url_citation からフォールバック構築する
4. **Product Hunt は topic ベース** — PH GraphQL API の posts クエリに search 引数がないため、query を topic スラッグに変換して検索。該当なければ最新投稿をクライアントサイドでキーワードフィルタする
5. **レート制限** — GitHub は認証なし 10 req/min、認証あり 30 req/min。短時間の連続使用で 429 になる可能性あり

---

## 開発経緯

- **2026-02-20**: 初期実装。Phase 1-4 を 1 セッションで完了、全 6 ソース動作確認済み
  - HN, npm, GitHub, PyPI: 問題なく動作
  - X: xAI Responses API のモデル名・レスポンス構造が想定と異なり修正（grok-4-1-fast-non-reasoning, tool_choice: required）
  - Product Hunt: GraphQL API に search 引数がなく、topic ベース + クライアントサイドフィルタに設計変更
  - PyPI: 当初 HTML スクレイピング方式だったが Cloudflare で遮断されたため JSON API + 名前候補方式に変更
  - scout_report comprehensive モードで 6/6 ソース成功確認（15件, ~19秒）
  - 外部レビュー指摘 5 件中 2 件（x_search fallback バグ、PH GraphQL エラー処理）を修正
- **2026-02-21**: x402 化 + 全棚登録完了
  - 10 有料エンドポイント（8 × $0.001 + $0.20 + $0.25）
  - bazaar_search 新規追加（CDP Discovery API クロール + テキスト検索）
  - CDP facilitator JWT 認証（@coinbase/x402 公式ヘルパー使用）
  - 全EP実支払テスト 30/30 成功（$0.20/$0.25 含む。地雷18: httpx timeout 修正で解決）
  - bazaar-selfpay 全自動化（13EP × 2パス、cron日曜4:00）
  - systemd + Cloudflare Named Tunnel でデプロイ
  - 全7棚登録完了: x402scan, ClawMart, awesome-x402 (PR #33, #38 Merged), Bazaar, RelAI, Apiosk, x402 Index
  - 古いプロセス残留によるポート競合を発見・修正（trust proxy 問題の真の原因）
