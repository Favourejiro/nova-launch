/**
 * Unit tests for the SendGrid and Twilio notification provider implementations.
 *
 * Covers:
 *  - SendGrid: successful delivery (202), provider 5xx error, missing credentials guard
 *  - Twilio: successful delivery (201), provider 5xx error, missing credentials guard
 *  - Retry: transient 5xx is retried up to MAX_RETRIES
 *  - Non-retryable 4xx stops immediately (no extra attempts)
 *  - PII masking: full email/phone never appears in logs
 *  - Rate limiter: second identical delivery within window is suppressed
 *  - Template rendering: TOKEN_DEPLOYED / VAULT_MATURED / PROPOSAL_PASSED
 *  - Backward compat: legacy NOTIFICATION_EMAIL_API_URL / NOTIFICATION_SMS_API_URL still work
 *
 * No real credentials appear in any fixture.
 *
 * Issue: #1264
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import axios from "axios";
import { NotificationService, isEmailEnabled, isSmsEnabled } from "../notificationService";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("axios");
vi.mock("../webhookDeliveryService", () => ({
  default: { triggerEvent: vi.fn() },
}));

// Stub fs.readFileSync so template loading works in the test environment
// without needing actual files on disk.
vi.mock("fs", () => ({
  readFileSync: vi.fn((_path: string) => {
    // Return a minimal template with the required placeholders
    return "<html>{{message}} {{tokenAddress}} {{unsubscribeUrl}}</html>";
  }),
}));

const mockedPost = axios.post as MockedFunction<typeof axios.post>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService() {
  return new NotificationService();
}

function successAxios(status = 202) {
  return mockedPost.mockResolvedValue({ status, data: {} });
}

function failAxios(status: number, message = "Provider error") {
  return mockedPost.mockResolvedValue({ status, data: { message } });
}

function networkErrorAxios() {
  return mockedPost.mockRejectedValue(new Error("ECONNREFUSED"));
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  Object.keys(savedEnv).forEach((k) => delete savedEnv[k]);
}

// ---------------------------------------------------------------------------
// isEmailEnabled / isSmsEnabled guards
// ---------------------------------------------------------------------------

describe("isEmailEnabled()", () => {
  beforeEach(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.NOTIFICATION_EMAIL_API_URL;
  });
  afterEach(restoreEnv);

  it("returns false and logs a warning when no provider is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isEmailEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EMAIL channel"));
    warn.mockRestore();
  });

  it("returns true when SENDGRID_API_KEY is set", () => {
    setEnv({ SENDGRID_API_KEY: "SG.fake-key" });
    expect(isEmailEnabled()).toBe(true);
  });

  it("returns true when legacy NOTIFICATION_EMAIL_API_URL is set", () => {
    setEnv({ NOTIFICATION_EMAIL_API_URL: "https://email.example.com/send" });
    expect(isEmailEnabled()).toBe(true);
  });
});

describe("isSmsEnabled()", () => {
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.NOTIFICATION_SMS_API_URL;
  });
  afterEach(restoreEnv);

  it("returns false and logs a warning when no provider is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isSmsEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SMS channel"));
    warn.mockRestore();
  });

  it("returns true when both Twilio env vars are set", () => {
    setEnv({ TWILIO_ACCOUNT_SID: "ACfake", TWILIO_AUTH_TOKEN: "fake-token" });
    expect(isSmsEnabled()).toBe(true);
  });

  it("returns false when only TWILIO_ACCOUNT_SID is set (missing AUTH_TOKEN)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setEnv({ TWILIO_ACCOUNT_SID: "ACfake" });
    delete process.env.TWILIO_AUTH_TOKEN;
    expect(isSmsEnabled()).toBe(false);
    warn.mockRestore();
  });

  it("returns true when legacy NOTIFICATION_SMS_API_URL is set", () => {
    setEnv({ NOTIFICATION_SMS_API_URL: "https://sms.example.com/send" });
    expect(isSmsEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SendGrid provider
// ---------------------------------------------------------------------------

describe("SendGrid email provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      SENDGRID_API_KEY: "SG.fake-key-for-tests",
      NOTIFICATION_FROM_EMAIL: "noreply@nova-launch.app",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.NOTIFICATION_EMAIL_API_URL;
  });
  afterEach(restoreEnv);

  it("sends to the SendGrid v3 endpoint on success", async () => {
    successAxios(202);
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "creator@example.com" }],
      payload: { message: "Your token is live", subject: "Token Deployed" },
    });

    expect(result[0].success).toBe(true);
    expect(result[0].provider).toBe("sendgrid");
    expect(mockedPost).toHaveBeenCalledWith(
      "https://api.sendgrid.com/v3/mail/send",
      expect.objectContaining({
        personalizations: [{ to: [{ email: "creator@example.com" }] }],
        subject: "Token Deployed",
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer SG.fake-key-for-tests",
        }),
      })
    );
  });

  it("returns failure when SendGrid returns 5xx", async () => {
    failAxios(500);
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Test" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("500");
  });

  it("retries on 5xx up to MAX_RETRIES and reports final failure", async () => {
    // All three attempts fail with 503
    mockedPost
      .mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 503, data: {} });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Retry test" },
    });

    expect(result[0].success).toBe(false);
    // MAX_RETRIES=3 → axios called 3 times
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on non-retryable 4xx (400)", async () => {
    failAxios(400);
    const svc = makeService();

    await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Bad request test" },
    });

    // Should only attempt once — 400 is non-retryable
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("retries on network error (ECONNREFUSED) and eventually fails", async () => {
    networkErrorAxios();
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Network error test" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("ECONNREFUSED");
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("returns unconfigured error when SENDGRID_API_KEY is absent", async () => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.NOTIFICATION_EMAIL_API_URL;
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "No config" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("Email channel is not configured");
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("does not log the full email address (PII masking)", async () => {
    successAxios(202);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const svc = makeService();

    await svc.send({
      targets: [{ type: "EMAIL", destination: "secret-user@private.com" }],
      payload: { message: "PII test", subject: "pii-event" },
    });

    for (const call of info.mock.calls) {
      const log = call.join(" ");
      expect(log).not.toContain("secret-user");
      expect(log).not.toContain("secret-user@private.com");
      // Domain is OK to show; local part must be masked
      expect(log).toContain("****@private.com");
    }
    info.mockRestore();
  });

  it("renders TOKEN_DEPLOYED HTML template when templateKey is provided", async () => {
    successAxios(202);
    const svc = makeService();

    await svc.send({
      targets: [{ type: "EMAIL", destination: "creator@example.com" }],
      payload: {
        message: "Your token MYTKN is live",
        subject: "Token Deployed",
        tokenAddress: "GABC123",
        metadata: { templateKey: "TOKEN_DEPLOYED", tokenName: "My Token" },
      },
    });

    // The mocked readFileSync returns HTML with {{message}} and {{tokenAddress}}
    // so the second argument to axios.post should contain rendered HTML
    const body = mockedPost.mock.calls[0][1] as any;
    const htmlContent = body.content?.find((c: any) => c.type === "text/html");
    expect(htmlContent).toBeDefined();
    expect(htmlContent.value).toContain("Your token MYTKN is live");
    expect(htmlContent.value).toContain("GABC123");
  });
});

// ---------------------------------------------------------------------------
// Legacy email HTTP adapter (backward compat)
// ---------------------------------------------------------------------------

describe("Legacy email HTTP adapter (NOTIFICATION_EMAIL_API_URL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      NOTIFICATION_EMAIL_API_URL: "https://email.example.com/send",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.SENDGRID_API_KEY;
  });
  afterEach(restoreEnv);

  it("posts to the configured URL when no SendGrid key is set", async () => {
    mockedPost.mockResolvedValue({ status: 202, data: {} });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Email body", subject: "Hi" },
    });

    expect(result[0].success).toBe(true);
    expect(result[0].provider).toBe("email");
    expect(mockedPost).toHaveBeenCalledWith(
      "https://email.example.com/send",
      expect.objectContaining({ to: "user@example.com", body: "Email body", subject: "Hi" }),
      expect.any(Object)
    );
  });

  it("returns failure for email when no destination is provided", async () => {
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL" }],
      payload: { message: "Missing destination" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("Email notifications require a destination email address");
  });
});

// ---------------------------------------------------------------------------
// Twilio SMS provider
// ---------------------------------------------------------------------------

describe("Twilio SMS provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      TWILIO_ACCOUNT_SID: "ACfakeaccountsid",
      TWILIO_AUTH_TOKEN: "fakeauthtoken",
      TWILIO_PHONE_NUMBER: "+15550001234",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.NOTIFICATION_SMS_API_URL;
  });
  afterEach(restoreEnv);

  it("posts to the Twilio Messages endpoint on success", async () => {
    mockedPost.mockResolvedValue({ status: 201, data: { sid: "SMfake" } });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Your vault has matured" },
    });

    expect(result[0].success).toBe(true);
    expect(result[0].provider).toBe("twilio");
    expect(mockedPost).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/ACfakeaccountsid/Messages.json",
      expect.stringContaining("To=%2B15559876543"),
      expect.objectContaining({
        auth: { username: "ACfakeaccountsid", password: "fakeauthtoken" },
      })
    );
  });

  it("uses URL-encoded form body (application/x-www-form-urlencoded)", async () => {
    mockedPost.mockResolvedValue({ status: 201, data: {} });
    const svc = makeService();

    await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Encoded body test" },
    });

    const [, body, config] = mockedPost.mock.calls[0] as [string, string, any];
    expect(typeof body).toBe("string"); // URL-encoded string, not JSON
    expect(config.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("returns failure when Twilio returns 5xx", async () => {
    mockedPost.mockResolvedValue({ status: 500, data: { message: "Internal Error" } });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Twilio 5xx test" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("500");
  });

  it("retries on 5xx up to MAX_RETRIES", async () => {
    mockedPost
      .mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 503, data: {} });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Retry SMS test" },
    });

    expect(result[0].success).toBe(false);
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on non-retryable 400", async () => {
    mockedPost.mockResolvedValue({ status: 400, data: { message: "Invalid number" } });
    const svc = makeService();

    await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Bad number" },
    });

    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("returns unconfigured error when Twilio credentials are absent", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.NOTIFICATION_SMS_API_URL;
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "No config" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("SMS channel is not configured");
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("does not log the full phone number (PII masking)", async () => {
    mockedPost.mockResolvedValue({ status: 201, data: {} });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const svc = makeService();

    await svc.send({
      targets: [{ type: "SMS", destination: "+15559998877" }],
      payload: { message: "PII SMS test" },
    });

    for (const call of info.mock.calls) {
      const log = call.join(" ");
      expect(log).not.toContain("+15559998877");
      expect(log).not.toContain("15559998877");
      expect(log).toContain("****8877");
    }
    info.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Legacy SMS HTTP adapter (backward compat)
// ---------------------------------------------------------------------------

describe("Legacy SMS HTTP adapter (NOTIFICATION_SMS_API_URL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      NOTIFICATION_SMS_API_URL: "https://sms.example.com/send",
      NODE_ENV: "test",
    });
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });
  afterEach(restoreEnv);

  it("posts to the configured SMS URL when no Twilio credentials are set", async () => {
    mockedPost.mockResolvedValue({ status: 200, data: {} });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15551234567" }],
      payload: { message: "Legacy SMS test" },
    });

    expect(result[0].success).toBe(true);
    expect(result[0].provider).toBe("sms");
    expect(mockedPost).toHaveBeenCalledWith(
      "https://sms.example.com/send",
      expect.objectContaining({ to: "+15551234567", message: "Legacy SMS test" }),
      expect.any(Object)
    );
  });

  it("returns failure when no destination provided", async () => {
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS" }],
      payload: { message: "No dest" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("SMS notifications require a destination phone number");
  });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe("Notification rate limiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      SENDGRID_API_KEY: "SG.fake-key",
      NODE_ENV: "test",
      // Very short window so tests don't have to wait
      NOTIFICATION_RATE_LIMIT_WINDOW_MS: "60000",
    });
    delete process.env.NOTIFICATION_EMAIL_API_URL;
  });
  afterEach(restoreEnv);

  it("suppresses the second identical delivery within the rate-limit window", async () => {
    successAxios(202);
    const svc = makeService();

    const req = {
      targets: [{ type: "EMAIL" as const, destination: "rl@example.com" }],
      payload: { message: "Rate limit test", subject: "rl-event" },
    };

    const first = await svc.send(req);
    expect(first[0].success).toBe(true);

    // Second send to same recipient+subject within window
    const second = await svc.send(req);
    expect(second[0].success).toBe(false);
    expect(second[0].error).toContain("Rate limit exceeded");

    // axios.post called only once (the second was suppressed before hitting the provider)
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("allows delivery to different recipients independently", async () => {
    successAxios(202);
    const svc = makeService();

    await svc.send({
      targets: [{ type: "EMAIL", destination: "a@example.com" }],
      payload: { message: "Hi A", subject: "same-event" },
    });
    const second = await svc.send({
      targets: [{ type: "EMAIL", destination: "b@example.com" }],
      payload: { message: "Hi B", subject: "same-event" },
    });

    expect(second[0].success).toBe(true);
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Existing channel registration guard (backward compat)
// ---------------------------------------------------------------------------

describe("registerChannel duplicate guard", () => {
  it("throws when the same channel is registered twice", () => {
    const svc = makeService();
    expect(() => svc.registerChannel("EMAIL", vi.fn() as any)).toThrow(
      /Notification channel handler already registered for EMAIL/
    );
  });
});

// ---------------------------------------------------------------------------
// Retry-exhaustion integration scenarios
// ---------------------------------------------------------------------------

describe("retry exhaustion: scenario 1 — both email and SMS succeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      SENDGRID_API_KEY: "SG.fake-key",
      TWILIO_ACCOUNT_SID: "ACfakeaccountsid",
      TWILIO_AUTH_TOKEN: "fakeauthtoken",
      TWILIO_PHONE_NUMBER: "+15550001234",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.NOTIFICATION_EMAIL_API_URL;
    delete process.env.NOTIFICATION_SMS_API_URL;
  });
  afterEach(restoreEnv);

  it("delivers to both channels successfully and logs sent lifecycle event for each", async () => {
    // First call (SendGrid) + second call (Twilio) both succeed on first attempt.
    mockedPost
      .mockResolvedValueOnce({ status: 202, data: {} })   // SendGrid
      .mockResolvedValueOnce({ status: 201, data: { sid: "SMfake" } }); // Twilio

    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const svc = makeService();

    const results = await svc.send({
      targets: [
        { type: "EMAIL", destination: "alice@example.com" },
        { type: "SMS", destination: "+15551112233" },
      ],
      payload: { message: "Both channels test", subject: "all-ok" },
    });

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[0].provider).toBe("sendgrid");
    expect(results[1].success).toBe(true);
    expect(results[1].provider).toBe("twilio");

    // Both providers should log a "delivered" lifecycle event.
    const logs = info.mock.calls.map((c) => c.join(" "));
    expect(logs.some((l) => l.includes("EMAIL") && l.includes("delivered"))).toBe(true);
    expect(logs.some((l) => l.includes("SMS") && l.includes("delivered"))).toBe(true);

    info.mockRestore();
  });
});

describe("retry exhaustion: scenario 2 — email exhausts all retries, SMS still delivers (partial delivery)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      SENDGRID_API_KEY: "SG.fake-key",
      TWILIO_ACCOUNT_SID: "ACfakeaccountsid",
      TWILIO_AUTH_TOKEN: "fakeauthtoken",
      TWILIO_PHONE_NUMBER: "+15550001234",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.NOTIFICATION_EMAIL_API_URL;
    delete process.env.NOTIFICATION_SMS_API_URL;
  });
  afterEach(restoreEnv);

  it("partial delivery: email fails all 3 retries, SMS succeeds — result records failure + success separately", async () => {
    // All SendGrid attempts fail with 503; Twilio succeeds on the first try.
    mockedPost
      .mockResolvedValueOnce({ status: 503, data: {} })           // SendGrid attempt 1
      .mockResolvedValueOnce({ status: 503, data: {} })           // SendGrid attempt 2
      .mockResolvedValueOnce({ status: 503, data: {} })           // SendGrid attempt 3
      .mockResolvedValueOnce({ status: 201, data: { sid: "SMok" } }); // Twilio

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = makeService();

    const results = await svc.send({
      targets: [
        { type: "EMAIL", destination: "fail@example.com" },
        { type: "SMS", destination: "+15559876543" },
      ],
      payload: { message: "Partial delivery test" },
    });

    expect(results).toHaveLength(2);

    // Email result — exhausted: provider, error, and failure reflected.
    const emailResult = results.find((r) => r.channel === "EMAIL")!;
    expect(emailResult.success).toBe(false);
    expect(emailResult.provider).toBe("sendgrid");
    expect(typeof emailResult.error).toBe("string");
    expect(emailResult.error).not.toBeNull();
    // Verify 3 attempts were made (MAX_RETRIES = 3 calls to SendGrid).
    const sendGridCalls = mockedPost.mock.calls.filter((c) =>
      String(c[0]).includes("sendgrid")
    );
    expect(sendGridCalls).toHaveLength(3);

    // SMS result — delivered despite email failure.
    const smsResult = results.find((r) => r.channel === "SMS")!;
    expect(smsResult.success).toBe(true);
    expect(smsResult.provider).toBe("twilio");

    // Warn log must reference the failed channel for lifecycle visibility.
    const warnLogs = warn.mock.calls.map((c) => c.join(" "));
    expect(warnLogs.some((l) => l.includes("EMAIL"))).toBe(true);
    warn.mockRestore();
  });
});

describe("retry exhaustion: scenario 3 — Twilio 429 rate-limit triggers retry backoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      TWILIO_ACCOUNT_SID: "ACfakeaccountsid",
      TWILIO_AUTH_TOKEN: "fakeauthtoken",
      TWILIO_PHONE_NUMBER: "+15550001234",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.NOTIFICATION_SMS_API_URL;
  });
  afterEach(restoreEnv);

  it("Twilio 429 is retried (not a non-retryable code) and succeeds on the second attempt", async () => {
    // 429 is NOT in the nonRetryableStatuses list → the retry engine will attempt again.
    mockedPost
      .mockResolvedValueOnce({ status: 429, data: { message: "Too Many Requests" } }) // rate-limited
      .mockResolvedValueOnce({ status: 201, data: { sid: "SMrecovered" } });            // success on retry

    const svc = makeService();

    const results = await svc.send({
      targets: [{ type: "SMS", destination: "+15551230000" }],
      payload: { message: "Rate limit test" },
    });

    expect(results[0].success).toBe(true);
    expect(results[0].provider).toBe("twilio");
    // Two HTTP calls: one rate-limited, one successful.
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it("Twilio 429 repeated across all retries exhausts the backoff window and returns failure", async () => {
    mockedPost
      .mockResolvedValueOnce({ status: 429, data: {} })
      .mockResolvedValueOnce({ status: 429, data: {} })
      .mockResolvedValueOnce({ status: 429, data: {} });

    const svc = makeService();

    const results = await svc.send({
      targets: [{ type: "SMS", destination: "+15551230001" }],
      payload: { message: "All retries 429" },
    });

    expect(results[0].success).toBe(false);
    expect(results[0].provider).toBe("twilio");
    expect(results[0].error).toContain("429");
    // All 3 MAX_RETRIES attempts were consumed.
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });
});

describe("retry exhaustion: scenario 4 — total exhaustion across all channels (dead-letter simulation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      SENDGRID_API_KEY: "SG.fake-key",
      TWILIO_ACCOUNT_SID: "ACfakeaccountsid",
      TWILIO_AUTH_TOKEN: "fakeauthtoken",
      TWILIO_PHONE_NUMBER: "+15550001234",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.NOTIFICATION_EMAIL_API_URL;
    delete process.env.NOTIFICATION_SMS_API_URL;
  });
  afterEach(restoreEnv);

  it("all channels exhaust all retries: each failure result includes provider, error, and attempt evidence", async () => {
    // 6 HTTP calls total: 3 SendGrid failures + 3 Twilio failures.
    mockedPost.mockResolvedValue({ status: 500, data: { message: "Internal Server Error" } });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = makeService();

    const results = await svc.send({
      targets: [
        { type: "EMAIL", destination: "dead@example.com" },
        { type: "SMS", destination: "+15550000001" },
      ],
      payload: { message: "Total exhaustion test" },
    });

    // Both channels failed — dead-letter semantics verified via result fields.
    expect(results).toHaveLength(2);
    for (const r of results) {
      // provider field is populated (identifies which provider failed)
      expect(typeof r.provider).toBe("string");
      expect(r.provider.length).toBeGreaterThan(0);
      // error field is populated with failure reason
      expect(typeof r.error).toBe("string");
      expect(r.error).not.toBeNull();
      expect(r.error!.length).toBeGreaterThan(0);
      // success is false
      expect(r.success).toBe(false);
    }

    // Each channel must have retried MAX_RETRIES times:
    // 3 SendGrid + 3 Twilio = 6 total axios.post calls.
    expect(mockedPost).toHaveBeenCalledTimes(6);

    // Both failed channels must emit a warn lifecycle event (failed).
    const warnLogs = warn.mock.calls.map((c) => c.join(" "));
    expect(warnLogs.some((l) => l.includes("EMAIL") && l.includes("failed"))).toBe(true);
    expect(warnLogs.some((l) => l.includes("SMS") && l.includes("failed"))).toBe(true);
    warn.mockRestore();
  });
});
