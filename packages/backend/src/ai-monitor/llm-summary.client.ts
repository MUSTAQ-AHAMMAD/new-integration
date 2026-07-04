import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DiagnosticSignals, Finding } from './ai-monitor.types';

/**
 * Optional LLM client that turns the deterministic findings into a concise,
 * human-friendly summary.
 *
 * Design goals:
 *  - Zero hard dependency: uses the built-in global `fetch` (Node 18+/22).
 *  - Fully optional: if no API key is configured, {@link summarise} returns
 *    `null` and the caller falls back to the deterministic rule-based summary.
 *  - Provider-agnostic: works with any OpenAI-compatible /chat/completions
 *    endpoint (OpenAI, Azure OpenAI gateways, local proxies, …).
 *
 * Configuration (all via env / ConfigService):
 *   AI_MONITOR_API_KEY   – API key (falls back to OPENAI_API_KEY)
 *   AI_MONITOR_API_URL   – chat completions URL
 *                          (default https://api.openai.com/v1/chat/completions)
 *   AI_MONITOR_MODEL     – model name (default gpt-4o-mini)
 */
@Injectable()
export class LlmSummaryClient {
  private readonly logger = new Logger(LlmSummaryClient.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  private getApiKey(): string | undefined {
    return (
      this.config.get<string>('AI_MONITOR_API_KEY') ||
      this.config.get<string>('OPENAI_API_KEY') ||
      undefined
    );
  }

  /**
   * Returns an AI-written summary, or `null` when the LLM is not configured or
   * the request fails for any reason (network, quota, malformed response).
   */
  async summarise(
    signals: DiagnosticSignals,
    findings: Finding[],
  ): Promise<string | null> {
    const apiKey = this.getApiKey();
    if (!apiKey) return null;

    const url =
      this.config.get<string>('AI_MONITOR_API_URL') ||
      'https://api.openai.com/v1/chat/completions';
    const model = this.config.get<string>('AI_MONITOR_MODEL') || 'gpt-4o-mini';

    const prompt = this.buildPrompt(signals, findings);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      const authHeader = 'Bearer '.concat(apiKey);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                'You are a senior site-reliability engineer for an Odoo → Oracle Fusion integration. ' +
                'Given a machine-generated diagnostics report, write a short, plain-language summary (max ~150 words) ' +
                'for a non-technical operator: what is wrong, the most likely root cause, and the single most important next step. ' +
                'Be concrete and do not invent issues beyond the provided findings.',
            },
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this.logger.warn(
          `LLM summary request failed with HTTP ${res.status}; falling back to rule-based summary.`,
        );
        return null;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data?.choices?.[0]?.message?.content?.trim();
      return content && content.length > 0 ? content : null;
    } catch (err) {
      this.logger.warn(
        `LLM summary unavailable (${
          err instanceof Error ? err.message : 'unknown error'
        }); falling back to rule-based summary.`,
      );
      return null;
    }
  }

  private buildPrompt(signals: DiagnosticSignals, findings: Finding[]): string {
    const findingLines = findings
      .map(
        (f, i) =>
          `${i + 1}. [${f.severity}] (${f.category}) ${f.title} — ${f.detail} Recommended fix: ${f.recommendation}`,
      )
      .join('\n');

    return [
      'DIAGNOSTIC FINDINGS:',
      findingLines || '(none — all checks passed)',
      '',
      'KEY SIGNALS:',
      JSON.stringify(
        {
          credentials: signals.credentials,
          queue: signals.queue,
          recentJobs: signals.recentJobs,
          failedTransactions: signals.failedTransactions,
          health: signals.health,
        },
        null,
        2,
      ),
    ].join('\n');
  }
}
