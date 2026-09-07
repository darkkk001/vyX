import "server-only";

// Swappable transactional email -- Stage 1 of the Client Portal build
// needs SOMETHING here (email verification, password reset) but this
// platform has never sent a real email anywhere (confirmed by search
// before this file existed: no Resend/nodemailer/SMTP anywhere in the
// codebase). Rather than block registration on setting up a real
// provider, this ships with a Mock adapter that logs the link/code
// server-side and returns it in the response outside production --
// registration/verification/reset are all fully testable end-to-end
// today. Swapping to Resend later is one env var
// (EMAIL_PROVIDER=resend) plus RESEND_API_KEY/EMAIL_FROM -- no call site
// anywhere else in the app needs to change, they only ever call sendMail.

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

export interface EmailAdapter {
  send(message: MailMessage): Promise<void>;
}

// Logs the message and, outside production, ALSO stashes the most recent
// one per recipient so a route handler can hand the link straight back
// in its own JSON response (see app/api/portal/register/route.ts) --
// nothing else in this app needs to poll an inbox to test the flow.
// Production still uses Mock until EMAIL_PROVIDER=resend is actually
// set, but never echoes the content back in a response there -- logging
// only, so a misconfigured production deploy fails loud (no email
// arrives) rather than silently leaking a verification link into an API
// response real traffic could see.
class MockEmailAdapter implements EmailAdapter {
  private lastByRecipient = new Map<string, MailMessage>();

  async send(message: MailMessage): Promise<void> {
    this.lastByRecipient.set(message.to, message);
    console.log(`[mock-email] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }

  // Dev/test-only escape hatch -- see this class's own comment.
  lastSentTo(to: string): MailMessage | null {
    return this.lastByRecipient.get(to) ?? null;
  }
}

// Resend's plain REST API via fetch -- no SDK dependency added for a
// path that's inert until a broker/deployment actually configures it
// (RESEND_API_KEY unset means this constructor is never reached, see
// getEmailAdapter below). https://resend.com/docs/api-reference/emails/send-email
class ResendEmailAdapter implements EmailAdapter {
  constructor(private apiKey: string, private from: string) {}

  async send(message: MailMessage): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
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

let cached: EmailAdapter | null = null;

// EMAIL_PROVIDER=resend + RESEND_API_KEY + EMAIL_FROM switches over;
// anything else (unset, "mock", a typo) stays on Mock rather than
// throwing -- a misconfigured provider name degrading to "still works,
// just doesn't send a real email" is a far safer failure mode for an
// auth-adjacent flow than registration/password-reset hard-erroring.
export function getEmailAdapter(): EmailAdapter {
  if (cached) return cached;

  if (process.env.EMAIL_PROVIDER === "resend" && process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
    cached = new ResendEmailAdapter(process.env.RESEND_API_KEY, process.env.EMAIL_FROM);
  } else {
    cached = new MockEmailAdapter();
  }
  return cached;
}

// Dev/test-only convenience -- see MockEmailAdapter's own comment. Not
// exported as part of the EmailAdapter interface; callers that need this
// know they're on Mock (Stage 1's entire target audience) and cast.
export function getMockLastSentTo(to: string): MailMessage | null {
  const adapter = getEmailAdapter();
  return adapter instanceof MockEmailAdapter ? adapter.lastSentTo(to) : null;
}
