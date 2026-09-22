/**
 * Email delivery port (ADR-001 §4). Unit 1 ships no real provider; a
 * transactional sender is wired in Phase 6 (Notifications) behind this
 * interface. Implementations must never log the raw token.
 */

export type AuthEmailKind = "EMAIL_VERIFICATION" | "PASSWORD_RESET";

export interface AuthEmail {
  kind: AuthEmailKind;
  to: string;
  /** Raw one-time token — the sender embeds it in a link; never persisted. */
  token: string;
}

export interface EmailSender {
  send(email: AuthEmail): Promise<void>;
}

/** Default sender: emits a redacted structured log line only. */
export class LogEmailSender implements EmailSender {
  async send(email: AuthEmail): Promise<void> {
    console.log(
      JSON.stringify({
        event: "auth.email.queued",
        kind: email.kind,
        to: redactEmail(email.to),
        // token intentionally omitted
      }),
    );
  }
}

/** Test/in-memory sender — captures messages for assertions. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: AuthEmail[] = [];
  async send(email: AuthEmail): Promise<void> {
    this.sent.push(email);
  }
  last(kind?: AuthEmailKind): AuthEmail | undefined {
    const list = kind ? this.sent.filter((e) => e.kind === kind) : this.sent;
    return list[list.length - 1];
  }
}

export function redactEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
