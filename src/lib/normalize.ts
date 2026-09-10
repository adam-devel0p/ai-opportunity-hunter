/**
 * Derives a company's canonical dedupe key from its website URL (spec §17).
 *
 * `https://www.example.com`, `http://example.com/`, and
 * `https://example.com/about?ref=x` must all resolve to the same
 * `normalizedDomain`, while the original `website` value is preserved
 * verbatim elsewhere for display/click-through — this function only
 * produces the identity key, never a replacement for the original URL.
 */
export function normalizeDomain(website: string): string {
  const trimmed = website.trim();
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  const url = new URL(withProtocol);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  return host;
}
