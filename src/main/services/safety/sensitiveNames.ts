/**
 * Names that hold credentials or stored secrets. A key, form field or query
 * parameter whose name contains one of them is never shown as-is: the browser
 * audit log, what an agent reads back from the browser, and the fields masked
 * in agent screenshots all use this one list. (SecretRedaction scans text for
 * secret values; that is a different job with its own rules.)
 */
const CREDENTIAL_SOURCE = "password|passwd|passcode|secret|token|api[-_]?key";

/** Keys and parameters: credentials, auth headers, cookies and web storage. */
const SENSITIVE_NAME_SOURCE =
  `${CREDENTIAL_SOURCE}|cookie|authorization|authheader|credential|localstorage|sessionstorage`;

/** Form fields (name, id, label, placeholder, title): credentials, one-time codes and anything auth. */
export const SENSITIVE_FIELD_SOURCE = `${CREDENTIAL_SOURCE}|api[-_ ]?key|one[-_ ]?time|otp|auth`;

const SENSITIVE_NAME = new RegExp(`(?:${SENSITIVE_NAME_SOURCE})`, "i");
const SENSITIVE_FIELD = new RegExp(`(?:${SENSITIVE_FIELD_SOURCE})`, "i");
const SENSITIVE_ASSIGNMENT = new RegExp(`(?:${SENSITIVE_NAME_SOURCE})=`, "i");

/** Whether a key or parameter name contains a sensitive name (case-insensitive, anywhere in the name). */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

/** Whether a form field's identity text (name, id, label, placeholder, title) marks it as sensitive. */
export function isSensitiveFieldIdentity(identity: string): boolean {
  return SENSITIVE_FIELD.test(identity);
}

/** Whether a text carries a `name=value` pair with a sensitive name, like a query string or a cookie header. */
export function hasSensitiveAssignment(text: string): boolean {
  return SENSITIVE_ASSIGNMENT.test(text);
}
