import "server-only";

// Swappable transactional email -- Stage 1 shipped with a single global
// Mock/Resend switch (EMAIL_PROVIDER env var). That was fine while no
// broker had its own domain, but multi-tenant sending needs each
// broker's mail to come from ITS OWN address (a Futurix client can't get
// an email "from" some other broker, and vice versa) -- so the decision
// of which adapter + which From address to use is now made PER SEND,
// keyed off the broker row passed in, not a process-wide cached
// singleton. RESEND_API_KEY itself stays a single global env var (one
// shared Resend account, each broker's From address verified as a
// sender identity/domain on that same account) -- see docs on adding a
// broker's domain to Resend before flipping its emailEnabled on.

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  // Plain-text fallback isn't optional at real providers the way it is
  // here -- Mock has no rendering step to skip it for, but Resend's own
  // adapter below always sends one, so this is never actually optional
  // in a way a caller has to think about.
  text: string;
};

// The subset of Broker a caller needs to already have selected (or
// fetch) to send on its behalf. Deliberately narrow so call sites that
// already query `name` for the email body (see app/api/portal/register)
// only need to widen that same `select`, not add a second query.
export type BrokerEmailConfig = {
  name: string;
  emailEnabled: boolean;
  emailFromAddress: string | null;
  emailFromName: string | null;
};

interface EmailAdapter {
  send(message: MailMessage & { from: string }): Promise<void>;
}

// Logs the message and, outside production, ALSO stashes the most
// recent one per recipient so a route handler can hand the link
// straight back in its own JSON response (see
// app/api/portal/register/route.ts) -- nothing else in this app needs
// to poll an inbox to test the flow. A broker stays on Mock until it
// has both emailEnabled=true AND an emailFromAddress configured; production
// still logs-only for those brokers rather than silently leaking a
// verification link into an API response real traffic could see.
class MockEmailAdapter implements EmailAdapter {
  private lastByRecipient = new Map<string, MailMessage>();

  async send(message: MailMessage & { from: string }): Promise<void> {
    this.lastByRecipient.set(message.to, message);
    console.log(`[mock-email] from=${message.from} to=${message.to} subject="${message.subject}"\n${message.text}`);
  }

  // Dev/test-only escape hatch -- see this class's own comment.
  lastSentTo(to: string): MailMessage | null {
    return this.lastByRecipient.get(to) ?? null;
  }
}

// Resend's plain REST API via fetch -- no SDK dependency added for a
// path that's inert until RESEND_API_KEY is actually configured (see
// getResendAdapter below). `from` is passed per-send now (broker-specific),
// not fixed at construction. https://resend.com/docs/api-reference/emails/send-email
class ResendEmailAdapter implements EmailAdapter {
  constructor(private apiKey: string) {}

  async send(message: MailMessage & { from: string }): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Resend send failed (${response.status}): ${body}`);
    }
  }
}

let mockAdapter: MockEmailAdapter | null = null;
let resendAdapter: ResendEmailAdapter | null = null;

function getMockAdapter(): MockEmailAdapter {
  if (!mockAdapter) mockAdapter = new MockEmailAdapter();
  return mockAdapter;
}

// Undefined/empty RESEND_API_KEY means every broker stays on Mock
// regardless of its own emailEnabled flag -- a broker turning email on
// doesn't do anything until the platform's own Resend account is wired
// up, same "missing config degrades to safe no-op" shape Stage 1 had.
function getResendAdapter(): ResendEmailAdapter | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!resendAdapter) resendAdapter = new ResendEmailAdapter(apiKey);
  return resendAdapter;
}

// Single entry point every send-an-email call site uses. Resolves
// Mock-vs-Resend AND the From address from the broker passed in, not a
// process-wide cache -- so two brokers' sends made moments apart on the
// same server correctly use two different From addresses/providers.
// Returns which adapter actually handled the send so callers can decide
// whether it's safe to echo a dev link back in their own response (only
// ever safe when Mock handled it -- see register/forgot-password routes).
export async function sendBrokerEmail(
  broker: BrokerEmailConfig,
  message: MailMessage
): Promise<{ usedMock: boolean }> {
  const resend = broker.emailEnabled && broker.emailFromAddress ? getResendAdapter() : null;

  if (resend) {
    const fromName = broker.emailFromName || broker.name;
    await resend.send({ ...message, from: `${fromName} <${broker.emailFromAddress}>` });
    return { usedMock: false };
  }

  await getMockAdapter().send({ ...message, from: broker.emailFromAddress ?? "mock@localhost" });
  return { usedMock: true };
}

// Dev/test-only convenience -- see MockEmailAdapter's own comment. Only
// ever finds something for a send that actually went through Mock.
export function getMockLastSentTo(to: string): MailMessage | null {
  return getMockAdapter().lastSentTo(to);
}
