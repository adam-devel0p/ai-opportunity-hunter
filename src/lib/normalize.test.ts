import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./normalize.js";

describe("normalizeDomain", () => {
  it("collapses protocol, www, trailing slash, and query string to the same identity", () => {
    const variants = [
      "https://www.example.com",
      "http://example.com/",
      "https://example.com/about?ref=x",
      "www.example.com",
      "example.com",
      "https://EXAMPLE.com",
    ];

    const normalized = variants.map(normalizeDomain);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe("example.com");
  });

  it("preserves distinct hosts as distinct", () => {
    expect(normalizeDomain("https://example.com")).not.toBe(
      normalizeDomain("https://example.co.uk"),
    );
    expect(normalizeDomain("https://sub.example.com")).not.toBe(
      normalizeDomain("https://example.com"),
    );
  });

  it("strips a fragment", () => {
    expect(normalizeDomain("https://example.com/about#team")).toBe(
      "example.com",
    );
  });
});
