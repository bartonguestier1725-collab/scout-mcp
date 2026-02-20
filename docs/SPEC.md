# Scout MCP — 仕様書

> **Version**: 0.1.0
> **Last Updated**: 2026-02-20
> **Status**: 全 8 ツール動作確認済み

---

## 1. 概要

Scout MCP は **6 つの情報ソースを横断検索する MCP サーバー**。
技術トレンド・競合・マーケット情報を構造化 JSON で返す。

現在は Claude Code のローカル MCP (stdio) として動作。
将来的に `https://scout.hugen.tokyo` で x402 エンドポイントとして外部公開予定。

### ソース一覧

| ソース | API | 認証 | コスト |
|--------|-----|------|--------|
| X (Twitter) | xAI Grok Responses API | XAI_API_KEY 必須 | 有料 (~$0.005/回) |
| Hacker News | Algolia API | 不要 | 無料 |
| npm | Registry REST API | 不要 | 無料 |
| GitHub | REST API v2022-11-28 | GITHUB_TOKEN 推奨 | 無料 |
| PyPI | JSON API (名前ベース lookup) | 不要 | 無料 |
| Product Hunt | GraphQL API + OAuth | PH_CLIENT_* 必須 | 無料 |

---

## 2. アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│                  Claude Code / Client                │
│                    (stdio transport)                  │
└──────────────────────┬──────────────────────────────┘
                       │ JSON-RPC over stdin/stdout
┌──────────────────────▼──────────────────────────────┐
│                   index.ts                           │
│              McpServer + StdioTransport              │
│                                                      │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐ │
│  │x_search │ │hn_search│ │npm_search│ │gh_search │ │
│  └────┬────┘ └────┬────┘ └────┬─────┘ └────┬─────┘ │
│  ┌────┴────┐ ┌────┴────┐ ┌────┴─────┐ ┌────┴─────┐ │
│  │pypi     │ │ph_search│ │gh_repo   │ │          │ │
│  └────┬────┘ └────┬────┘ └────┬─────┘ │  scout   │ │
│       │           │           │        │  report  │ │
│       └───────────┴───────────┘        │(並列合成)│ │
│               fetch-utils.ts           └──────────┘ │
│          (timeout / error handling)                   │
└──────────────────────────────────────────────────────┘
```

### 設計原則

1. **execute() は例外を投げない** — 常に `ToolResult` (`success: true/false`) を返す
2. **1 ソース失敗 ≠ 全滅** — `scout_report` は `Promise.allSettled` で部分的成功を許容
3. **stdout は MCP プロトコル専用** — デバッグは `console.error()` のみ
4. **ステートレス** — 各リクエスト独立（PH OAuth トークンのみインメモリキャッシュ）

---

## 3. 共通型定義

### ToolResult

全ツールが返す統一フォーマット。

```typescript
{
  success: boolean;        // 成功/失敗
  source: string;          // ソース識別子 ("hn", "x", "npm", "github", "pypi", "producthunt")
  query: string;           // 検索クエリ（入力そのまま）
  data: unknown;           // ソース固有の結果配列（後述）
  count: number;           // 返却件数
  elapsed_ms: number;      // 処理時間（ミリ秒）
  cost_estimate?: {        // コスト情報（有料ソースのみ）
    usd: number;
    breakdown: Record<string, number>;
  };
  error?: string;          // 失敗時のエラーメッセージ
}
```

### エラーレスポンス例

```json
{
  "success": false,
  "source": "x",
  "query": "MCP server",
  "data": null,
  "count": 0,
  "elapsed_ms": 123,
  "error": "XAI_API_KEY not configured"
}
```

---

## 4. ツール仕様

---

### 4.1 x_search — X (Twitter) 検索

xAI の Grok API (Responses API) + web_search ツールで X の投稿を検索する。

#### 入力

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|-----------|------|
| `query` | string | 必須 | — | 検索クエリ |
| `recency` | `"day"` \| `"week"` \| `"month"` | 任意 | `"week"` | 期間フィルタ |
| `per_page` | number (1-20) | 任意 | `10` | 取得件数 |

#### 出力 (data)

```typescript
Array<{
  author: string;       // 投稿者
  text: string;         // 投稿本文
  url: string;          // 投稿 URL
  date: string;         // 投稿日時
}>
```

フォールバック時（JSON パース失敗）:
```typescript
Array<{
  url: string;          // URL citation から抽出
  title: string;        // タイトル（取得可能な場合）
  source: "url_citation";
}>
```

#### コスト情報

```typescript
cost_estimate: {
  usd: number;          // cost_in_usd_ticks / 10^9（正確値）
  breakdown: {          // またはトークン数からの推定値
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }
}
```

#### 内部動作

1. `grok-4-1-fast-non-reasoning` モデルに web_search を `tool_choice: "required"` で強制
2. LLM の出力テキストから JSON 配列をパース
3. パース失敗時 → `output_text` の `annotations` (url_citation) からフォールバック構築
4. タイムアウト: 45 秒

#### 制約

- レスポンスは LLM 生成のため構造が不安定なことがある
- web_search ツール使用分のコストが加算されるため、実コストはトークン推定より高い

---

### 4.2 hackernews_search — Hacker News 検索

Algolia の HN Search API で記事・コメントを検索する。

#### 入力

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|-----------|------|
| `query` | string | 必須 | — | 検索クエリ |
| `sort` | `"relevance"` \| `"date"` | 任意 | `"relevance"` | ソート順 |
| `per_page` | number (1-50) | 任意 | `10` | 取得件数 |
| `tag` | string | 任意 | — | フィルタ (`"story"`, `"comment"`, `"poll"`, `"show_hn"`, `"ask_hn"`) |

#### 出力 (data)

```typescript
Array<{
  id: string;           // Algolia objectID
  title: string;        // 記事タイトル（コメントの場合 "(comment)"）
  url: string;          // 元記事 URL（なければ HN リンク）
  hn_url: string;       // HN のディスカッションページ
  author: string;       // 投稿者名
  points: number|null;  // ポイント数
  comments: number|null;// コメント数
  date: string;         // 投稿日時 (ISO 8601)
  type: string;         // "story", "comment" 等
}>
```

#### 内部動作

- `sort=relevance` → `/api/v1/search`
- `sort=date` → `/api/v1/search_by_date`
- `tag` 指定時はクエリパラメータに `tags=` を追加

---

### 4.3 npm_search — npm パッケージ検索

npm Registry の検索 API でパッケージを検索する。

#### 入力

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|-----------|------|
| `query` | string | 必須 | — | パッケージ名・キーワード |
| `per_page` | number (1-50) | 任意 | `10` | 取得件数 |

#### 出力 (data)

```typescript
Array<{
  name: string;         // パッケージ名
  version: string;      // 最新バージョン
  description: string;  // 説明
  keywords: string[];   // キーワード配列
  npm_url: string;      // npmjs.com のリンク
  homepage: string|null;
  repository: string|null;
  publisher: string|null;
  updated: string;      // 最終更新日 (ISO 8601)
  score: {
    final: number;      // 総合スコア (0-1)
    quality: number;
    popularity: number;
    maintenance: number;
  }
}>
```

---

### 4.4 github_search — GitHub リポジトリ検索

GitHub REST API でリポジトリを検索する。

#### 入力

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|-----------|------|
| `query` | string | 必須 | — | 検索クエリ（`topic:mcp` 等の修飾子対応） |
| `sort` | `"stars"` \| `"forks"` \| `"updated"` \| `"best-match"` | 任意 | `"best-match"` | ソート順 |
| `per_page` | number (1-50) | 任意 | `10` | 取得件数 |
| `language` | string | 任意 | — | 言語フィルタ（例: `"typescript"`） |

#### 出力 (data)

```typescript
Array<{
  name: string;         // "owner/repo" 形式
  url: string;          // GitHub ページ URL
  description: string|null;
  stars: number;
  forks: number;
  open_issues: number;
  language: string|null;
  topics: string[];
  license: string|null; // SPDX ID (例: "MIT")
  created: string;      // ISO 8601
  updated: string;
}>
```

#### 制約

- 認証なし: 10 req/min、認証あり: 30 req/min
- `language` はクエリ文字列に `language:${language}` として追加

---

### 4.5 github_repo_info — GitHub リポジトリ詳細

特定リポジトリの詳細情報を取得する。

#### 入力

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|-----------|------|
| `owner` | string | 必須 | — | リポジトリオーナー |
| `repo` | string | 必須 | — | リポジトリ名 |
| `include_contributors` | boolean | 任意 | `false` | 上位 10 名のコントリビュータ |
| `include_releases` | boolean | 任意 | `false` | 直近 5 件のリリース |

#### 出力 (data)

```typescript
{
  name: string;           // "owner/repo"
  url: string;
  description: string|null;
  homepage: string|null;
  stars: number;
  forks: number;
  watchers: number;
  open_issues: number;
  subscribers: number;
  network: number;
  language: string|null;
  topics: string[];
  license: { id: string; name: string } | null;
  default_branch: string;
  size_kb: number;
  archived: boolean;
  is_fork: boolean;
  created: string;
  updated: string;
  pushed: string;
  top_contributors?: Array<{   // include_contributors=true 時のみ
    login: string;
    contributions: number;
    url: string;
  }>;
  recent_releases?: Array<{    // include_releases=true 時のみ
    tag: string;
    name: string|null;
    published: string;
    prerelease: boolean;
  }>;
}
```

#### 内部動作

- リポジトリ詳細 + contributors + releases を `Promise.all` で並列取得
- `count` は常に `1`

---

### 4.6 pypi_search — PyPI パッケージ検索

PyPI JSON API でパッケージを名前ベースで lookup する。

#### 入力

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|-----------|------|
| `query` | string | 必須 | — | パッケージ名（近似名可） |
| `per_page` | number (1-20) | 任意 | `5` | 取得件数 |

#### 出力 (data)

```typescript
Array<{
  name: string;
  version: string;         // 最新バージョン
  summary: string;
  pypi_url: string;        // https://pypi.org/project/{name}/
  homepage: string|null;
  repository: string|null;
  author: string|null;
  license: string|null;
  requires_python: string|null;  // 例: ">=3.8"
  keywords: string[];
  release_count: number;   // 総バージョン数
  latest_upload: string|null;  // 最新アップロード日
}>
```

#### 内部動作（名前候補生成方式）

公式の検索 API が Cloudflare に保護されているため、以下の方式で回避:

1. クエリから候補名を生成:
   - そのまま小文字化
   - スペース/アンダースコア → ハイフン置換
   - スペース/ハイフン → アンダースコア置換
   - `python-*`, `py*`, `*-python`, `*-py` プレフィックス/サフィックス
   - 複合語の場合は結合（スペース除去）
2. 全候補を `/pypi/<name>/json` に並列リクエスト
3. 正規化名で重複排除
4. タイムアウト: 5 秒

#### 制約

- **キーワード検索には弱い** — あくまでパッケージ名ベースの lookup
- 404 と API 障害を区別できない（どちらも null 扱い）

---

### 4.7 producthunt_search — Product Hunt 検索

Product Hunt GraphQL API でプロダクトを検索する。

#### 入力

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|-----------|------|
| `query` | string | 必須 | — | トピック名またはキーワード |
| `order` | `"VOTES"` \| `"NEWEST"` | 任意 | `"VOTES"` | ソート順 |
| `per_page` | number (1-20) | 任意 | `10` | 取得件数 |

#### 出力 (data)

```typescript
Array<{
  id: string;
  name: string;
  tagline: string;        // 一行説明
  description: string;    // 詳細説明
  ph_url: string;         // Product Hunt ページ
  website: string;        // プロダクトの Web サイト
  votes: number;
  comments: number;
  date: string;           // 公開日 (ISO 8601)
  topics: string[];       // 関連トピック名の配列
  makers: Array<{
    name: string;
    username: string;
  }>;
  thumbnail: string|null; // サムネイル URL
}>
```

#### 内部動作（2 段階検索）

PH GraphQL API の `posts` クエリには `search` 引数が存在しないため:

1. **Topic ベース検索**: クエリを topic スラッグに変換 (`"AI tools"` → `"ai-tools"`) → `posts(topic: ...)` で取得
2. **フォールバック**: Topic 検索が空の場合 → `posts(first: N, order: ...)` で最新投稿を取得 → クライアントサイドでキーワードフィルタ（name + tagline + description の部分一致）

フォールバック時は `per_page × 3`（最大 20）件を取得してからフィルタする。

#### 認証

- `PH_CLIENT_ID` + `PH_CLIENT_SECRET` で OAuth Client Credentials トークンを取得
- トークンはインメモリキャッシュ（有効期限 - 60 秒でリフレッシュ）

---

### 4.8 scout_report — 複合レポート

複数ソースを並列実行し、結果を 1 つのレポートに合成する。

#### 入力

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|-----------|------|
| `query` | string | 必須 | — | 全ソースに共通の検索クエリ |
| `sources` | string[] | 任意 | — | 使用するソースを明示指定 |
| `focus` | `"balanced"` \| `"trending"` \| `"comprehensive"` | 任意 | `"balanced"` | プリセット |
| `per_page` | number (1-20) | 任意 | `5` | 各ソースの取得件数 |

#### focus プリセット

| focus | 使うソース | 主な用途 |
|-------|-----------|---------|
| `balanced` | HN, GitHub, npm, PyPI | 無料ソースのみ。開発中のデフォルト |
| `trending` | HN, X, Product Hunt | トレンド・話題の把握 |
| `comprehensive` | 全 6 ソース | 網羅的な調査 |

`sources` を明示指定した場合は `focus` より優先される。

#### 出力 (data)

```typescript
{
  summary: {
    query: string;
    focus: string;
    sources_requested: string[];  // リクエストしたソース一覧
    sources_succeeded: number;    // 成功したソース数
    sources_failed: number;       // 失敗したソース数
    total_results: number;        // 全ソースの結果合計
  };
  results: {
    [sourceId: string]: ToolResult;  // 各ソースの完全な ToolResult
  };
}
```

#### コスト集計

有料ソース（X）を含む場合、全ソースのコストを合算:
```typescript
cost_estimate: {
  usd: number;                    // 合計 USD
  breakdown: {
    [sourceId: string]: number;   // ソース別 USD
  }
}
```

#### 内部動作

- `Promise.allSettled` で全ソースを並列実行
- 1 ソースが失敗しても他のソースの結果は正常に返る
- `elapsed_ms` は並列実行の wall-clock 時間

---

## 5. パフォーマンス特性

| ツール | 平均レスポンス時間 | レート制限 |
|--------|-------------------|-----------|
| x_search | 10-15 秒 | xAI API 依存 |
| hackernews_search | 0.5-2 秒 | 制限なし |
| npm_search | 0.5-2 秒 | 制限なし |
| github_search | 1-3 秒 | 30 req/min (認証時) |
| github_repo_info | 1-3 秒 | 30 req/min (認証時) |
| pypi_search | 2-5 秒 | 制限なし |
| producthunt_search | 2-4 秒 | GraphQL API 依存 |
| scout_report (balanced) | 2-5 秒 | ソース依存 |
| scout_report (comprehensive) | 10-20 秒 | X がボトルネック |

---

## 6. エラーハンドリング

### 基本方針

```
execute() → 常に ToolResult を返す（例外を投げない）
  ├── 成功 → ok(source, query, data, count, elapsed_ms, cost?)
  └── 失敗 → fail(source, query, errorMessage, elapsed_ms)
```

### エラーの種類

| 状況 | 挙動 |
|------|------|
| API キー未設定 | `fail("source", query, "... not configured", ...)` |
| HTTP エラー (4xx/5xx) | `ScoutError` にラップ → `fail()` |
| タイムアウト | `AbortController` で中断 → `fail()` |
| JSON パース失敗 | ソースにより異なる（x_search はフォールバック、他は fail） |
| レート制限 (429) | `ScoutError.retryAfter` にヘッダー値を保持 → `fail()` |
| scout_report の部分失敗 | 失敗ソースは results に `success: false` で含まれ、他は正常返却 |

---

## 7. 環境変数

| 変数名 | 必要なツール | 説明 |
|--------|-------------|------|
| `XAI_API_KEY` | x_search | xAI API キー。有料 |
| `GITHUB_TOKEN` | github_search, github_repo_info | GitHub PAT。なくても動くがレート制限が厳しい |
| `PH_CLIENT_ID` | producthunt_search | Product Hunt Developer App の Client ID |
| `PH_CLIENT_SECRET` | producthunt_search | Product Hunt Developer App の Client Secret |

---

## 8. 技術スタック

| 項目 | 技術 |
|------|------|
| Runtime | Node.js 24 (built-in fetch) |
| Language | TypeScript (ES2022, Node16 module) |
| MCP SDK | `@modelcontextprotocol/sdk` v1.26 |
| Schema | zod v4 |
| Transport | stdio (JSON-RPC) |
| 依存パッケージ | 3 個のみ（MCP SDK, zod, dotenv） |

---

## 9. x402 化に向けたメモ

### 現在の設計が x402 に適している点

- **ステートレス** — 各リクエストが独立。セッション管理不要
- **cost_estimate 内蔵** — 有料ソースのコスト情報が ToolResult に含まれる
- **統一レスポンス形式** — 全ツールが同じ `ToolResult` 構造を返す
- **部分失敗許容** — scout_report は一部失敗しても結果を返す

### x402 化時の検討事項

| 項目 | 方針案 |
|------|--------|
| エンドポイント | `https://scout.hugen.tokyo` |
| ポート | 4023 |
| サービス管理 | `x402ctl add scout 4023` |
| HTTP ラッパー | FastAPI (Python) or Express/Hono (Node.js) |
| 価格設定 | X 使用時のみ有料。balanced (無料ソースのみ) は低価格に |
| 認証 | x402 ミドルウェアで処理 |
| discovery | `/.well-known/x402` に 8 ツールを宣言 |
| 配信 | Bazaar → x402scan → x402list.fun → RelAI → Fluora |

### 価格設定の参考データ

| プラン | 含まれるソース | 原価目安 |
|--------|---------------|---------|
| Free tier (balanced) | HN + GitHub + npm + PyPI | $0 |
| Standard (trending) | HN + X + Product Hunt | ~$0.005/回 (X コスト) |
| Premium (comprehensive) | 全 6 ソース | ~$0.005/回 (X コスト) |

---

## 10. CLI テスト方法

```bash
# ビルド
npm run build

# 個別ツール
node build/cli.js hackernews_search '{"query":"MCP server","per_page":3}'
node build/cli.js npm_search '{"query":"mcp","per_page":3}'
node build/cli.js github_search '{"query":"x402","sort":"stars","per_page":3}'
node build/cli.js github_repo_info '{"owner":"anthropics","repo":"claude-code"}'
node build/cli.js pypi_search '{"query":"fastapi"}'
node build/cli.js producthunt_search '{"query":"artificial-intelligence","per_page":3}'

# 合成レポート（無料ソースのみ）
node build/cli.js scout_report '{"query":"MCP","sources":["hn","github","npm"]}'

# 合成レポート（全ソース）
node build/cli.js scout_report '{"query":"LLM agents","focus":"comprehensive","per_page":3}'
```

---

## 11. 既知の制限事項

1. **PyPI は名前ベース lookup** — キーワード検索に弱い。API 障害と 0 件を区別できない
2. **X 検索は LLM 経由** — レスポンス構造が不安定。JSON パース失敗時は url_citation にフォールバック
3. **Product Hunt は topic ベース** — 検索引数がない API 制約。クライアントサイドフィルタで補完
4. **GitHub レート制限** — 認証あり 30 req/min。短時間の連続使用で 429 の可能性
5. **X のコスト** — web_search ツール使用分が加算され、トークン推定より高くなる場合がある
