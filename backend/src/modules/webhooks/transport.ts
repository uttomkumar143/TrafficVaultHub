/**
 * Outbound HTTP port for webhook delivery (Phase 6 Unit 4; PRD §74).
 *
 * The service never calls `fetch` directly: it hands a fully signed request
 * to a `WebhookTransport` and classifies the result. Tests inject a scripted
 * transport (no network); the Worker uses `FetchWebhookTransport`.
 */

export interface WebhookRequest {
  url: string;
  /** Always POST; kept explicit because it is part of the signed canonical string. */
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export type WebhookTransportResult =
  | { kind: "response"; status: number }
  | { kind: "network_error"; code: string }
  | { kind: "timeout" };

export interface WebhookTransport {
  send(req: WebhookRequest, timeoutMs: number): Promise<WebhookTransportResult>;
}

/** Real transport: `fetch` with an AbortController deadline. Response bodies are never read or stored. */
export class FetchWebhookTransport implements WebhookTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(req: WebhookRequest, timeoutMs: number): Promise<WebhookTransportResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "manual", signal: ac.signal });
      return { kind: "response", status: res.status };
    } catch (err) {
      if (ac.signal.aborted) return { kind: "timeout" };
      return { kind: "network_error", code: err instanceof Error && err.name ? err.name.toUpperCase().slice(0, 64) : "NETWORK_ERROR" };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Test transport: records every request and answers from a script. The
 * default (empty script) answers 200 so the happy path needs no setup.
 */
export class ScriptedWebhookTransport implements WebhookTransport {
  readonly sent: WebhookRequest[] = [];
  private readonly script: WebhookTransportResult[] = [];

  /** Queue the next result(s), consumed FIFO; falls back to 200 when exhausted. */
  enqueue(...results: WebhookTransportResult[]): this {
    this.script.push(...results);
    return this;
  }

  async send(req: WebhookRequest): Promise<WebhookTransportResult> {
    this.sent.push(req);
    return this.script.shift() ?? { kind: "response", status: 200 };
  }
}
