/**
 * Gemini Synthesizer – AI-powered report synthesis using Gemini Flash-Lite
 *
 * Takes raw scout_report results and produces a structured synthesis:
 * summary, key findings, sentiment, trends, and recommendations.
 *
 * On Gemini failure, returns null (caller should return 200 + synthesis: null).
 */

import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import type { ToolResult } from "../types.js";

export const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";

export type ResearchFocus = "technical" | "market" | "sentiment";

export interface Synthesis {
  summary: string;
  key_findings: string[];
  sources_analyzed: number;
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  trends: string[];
  recommendations: string[];
}

const FOCUS_INSTRUCTIONS: Record<ResearchFocus, string> = {
  technical:
    "Focus on technical aspects: architecture decisions, implementation patterns, " +
    "performance characteristics, compatibility, and developer experience. " +
    "Highlight technical trade-offs and best practices.",
  market:
    "Focus on market aspects: adoption trends, competitive landscape, funding, " +
    "pricing models, target audience, and business viability. " +
    "Highlight market opportunities and risks.",
  sentiment:
    "Focus on community sentiment: developer opinions, praise and criticism, " +
    "adoption barriers, common pain points, and enthusiasm levels. " +
    "Highlight consensus views and contrarian perspectives.",
};

const SYSTEM_PROMPT = `You are a research analyst. Synthesize the provided multi-source search results into a structured report.

RULES:
- Base your analysis ONLY on the provided data. Do not invent information.
- Be concise but comprehensive. Summary should be 2-3 paragraphs.
- Identify 3-5 key findings, trends, and recommendations.
- Assess overall sentiment as one of: positive, neutral, negative, mixed.
- If data is sparse or unclear, say so honestly.

OUTPUT FORMAT (strict JSON, no markdown wrapping):
{
  "summary": "2-3 paragraph synthesis",
  "key_findings": ["finding 1", "finding 2", ...],
  "sentiment": "positive|neutral|negative|mixed",
  "trends": ["trend 1", "trend 2", ...],
  "recommendations": ["rec 1", "rec 2", ...]
}`;

/**
 * Extract compact text from scout_report results for Gemini input.
 * Only title + description/summary to save tokens.
 */
function extractCompactData(reportData: unknown): {
  text: string;
  sourcesAnalyzed: number;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = reportData as any;
  const results = data?.results ?? {};
  const lines: string[] = [];
  let sourcesAnalyzed = 0;

  for (const [sourceId, sourceResult] of Object.entries(results)) {
    const sr = sourceResult as ToolResult;
    if (!sr.success || sr.count === 0) continue;
    sourcesAnalyzed++;

    lines.push(`\n## ${sourceId.toUpperCase()} (${sr.count} results)`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (sr.data as any)?.results ?? sr.data;
    if (!Array.isArray(items)) continue;

    // Take up to 5 items per source to limit tokens
    for (const item of items.slice(0, 5)) {
      const title = item.title || item.name || item.text || "";
      const desc =
        item.description || item.summary || item.tagline || item.brief || "";
      if (title) {
        lines.push(`- ${title}${desc ? `: ${desc.slice(0, 200)}` : ""}`);
      }
    }
  }

  return { text: lines.join("\n"), sourcesAnalyzed };
}

/**
 * Synthesize scout_report results using Gemini Flash-Lite.
 * Returns null on any Gemini error (graceful degradation).
 */
export async function synthesize(
  query: string,
  reportData: unknown,
  focus: ResearchFocus = "technical",
): Promise<Synthesis | null> {
  if (!config.GEMINI_API_KEY) {
    console.error("[gemini-synthesizer] GEMINI_API_KEY not configured, skipping synthesis");
    return null;
  }

  const { text, sourcesAnalyzed } = extractCompactData(reportData);

  if (sourcesAnalyzed === 0 || text.trim().length === 0) {
    console.error("[gemini-synthesizer] No data to synthesize");
    return null;
  }

  try {
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

    const userPrompt =
      `Query: "${query}"\n\n` +
      `Analysis focus: ${FOCUS_INSTRUCTIONS[focus]}\n\n` +
      `Data from ${sourcesAnalyzed} sources:\n${text}`;

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.3,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      },
    });

    const raw = response.text?.trim();
    if (!raw) {
      console.error("[gemini-synthesizer] Empty response from Gemini");
      return null;
    }

    const parsed = JSON.parse(raw);

    // Validate required fields
    if (
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.key_findings)
    ) {
      console.error("[gemini-synthesizer] Invalid response structure:", Object.keys(parsed));
      return null;
    }

    return {
      summary: parsed.summary,
      key_findings: parsed.key_findings.slice(0, 10),
      sources_analyzed: sourcesAnalyzed,
      sentiment: ["positive", "neutral", "negative", "mixed"].includes(parsed.sentiment)
        ? parsed.sentiment
        : "neutral",
      trends: Array.isArray(parsed.trends) ? parsed.trends.slice(0, 10) : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 10)
        : [],
    };
  } catch (err) {
    console.error(
      "[gemini-synthesizer] Synthesis failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
