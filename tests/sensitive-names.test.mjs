import assert from "node:assert/strict";
import test from "node:test";
import { redactAuditValue } from "../src/main/services/browser/BrowserAuditStore.ts";
import { isSensitiveFieldIdentity, isSensitiveName } from "../src/main/services/safety/sensitiveNames.ts";

const names = [
  "password", "Passwd", "PASSCODE", "clientSecret", "sessionCookie", "Authorization", "authHeader", "credentials",
  "access_token", "refreshToken", "apiKey", "api-key", "api_key", "api key", "localStorage", "SessionStorage",
  "one-time code", "otp", "author", "oauth", "title", "url", "value", "keyboard", "monkey", "tokenizer", "secretary"
];

test("what an agent reads back and which fields screenshots mask stay exactly as before", () => {
  // The lists BrowserCore and BrowserAutomationService carried before they moved to one place.
  const agentValues = /(?:password|passwd|passcode|secret|cookie|authorization|authheader|credential|token|api[-_]?key|localstorage|sessionstorage)/i;
  const fields = /(?:password|passwd|passcode|one[-_ ]?time|otp|token|secret|api[-_ ]?key|auth(?:orization)?)/i;
  for (const name of names) {
    assert.equal(isSensitiveName(name.toLowerCase()), agentValues.test(name.toLowerCase()), name);
    assert.equal(isSensitiveFieldIdentity(name.toLowerCase()), fields.test(name.toLowerCase()), name);
  }
});

test("the audit log redacts every sensitive name, not only the exact keys it listed", () => {
  const redacted = redactAuditValue({
    passcode: "1234", apiKey: "k", "x-refresh-token": "t", sessionStorage: { a: 1 }, text: "typed",
    tabTitle: "Inbox", count: 3, link: "https://example.test/a?passcode=1", note: "a=1&passcode=2"
  });
  assert.deepEqual(redacted, {
    passcode: "[REDACTED]", apiKey: "[REDACTED]", "x-refresh-token": "[REDACTED]", sessionStorage: "[REDACTED]",
    text: "[REDACTED]", tabTitle: "Inbox", count: 3, link: "https://example.test/a", note: "[REDACTED]"
  });
});
