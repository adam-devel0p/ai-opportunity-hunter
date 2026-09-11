/** Display-only formatting helpers for the dashboard UI. Not shared with backend code — this is
 * presentation, not domain logic (contrast with e.g. `src/lib/scoring.ts`, which is real domain
 * arithmetic every caller must get identically). */

export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function formatDateTime(date: Date | null | undefined): string {
  if (!date) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function formatScore(average: number | null | undefined): string {
  if (average == null) return "—";
  return average.toFixed(1);
}
