import Link from "next/link";
import { getDb } from "../../lib/appDb";
import { listCompanies, type CompanyListFilters } from "../../lib/dashboardQueries";
import { formatDate } from "../format";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const LIFECYCLE_STATUSES = [
  "DISCOVERED",
  "PRESCREEN_PENDING",
  "PRESCREENED",
  "RESEARCH_PENDING",
  "RESEARCHED",
  "NO_OPPORTUNITY",
  "DISCARDED",
  "EXCLUDED",
] as const;

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters: CompanyListFilters = {
    lifecycleStatus: first(params.status) as CompanyListFilters["lifecycleStatus"],
    search: first(params.search) || undefined,
  };
  const db = getDb();
  const rows = listCompanies(db, filters);

  return (
    <>
      <div className="page-header">
        <h1>Companies</h1>
        <p>{rows.length} matching compan{rows.length === 1 ? "y" : "ies"}.</p>
      </div>

      <form method="get" className="filter-bar">
        <label>
          Search (name/domain)
          <input type="text" name="search" defaultValue={filters.search ?? ""} />
        </label>
        <label>
          Lifecycle status
          <select name="status" defaultValue={filters.lifecycleStatus ?? ""}>
            <option value="">Any</option>
            {LIFECYCLE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Apply filters</button>
        <a href="/companies">Clear</a>
        <a href="/companies/new" style={{ marginLeft: "auto" }}>
          + Research a company
        </a>
      </form>

      {rows.length === 0 ? (
        <p className="empty-state">No companies match these filters yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Country</th>
              <th>Industry</th>
              <th>Lifecycle</th>
              <th>Last discovered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/companies/${row.id}`}>{row.name}</Link>
                </td>
                <td>{row.country ?? "—"}</td>
                <td>{row.industry ?? "—"}</td>
                <td>
                  <span className="badge badge--neutral">{row.lifecycleStatus}</span>
                </td>
                <td>{formatDate(row.lastDiscoveredAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
