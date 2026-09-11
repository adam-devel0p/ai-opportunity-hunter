import Link from "next/link";
import { getDb } from "../../lib/appDb";
import { listOpportunities, type OpportunityListFilters } from "../../lib/dashboardQueries";
import { formatDate } from "../format";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function verdictBadgeClass(verdict: string): string {
  if (verdict === "APPROVED") return "badge badge--good";
  if (verdict === "REJECTED") return "badge badge--bad";
  return "badge badge--neutral";
}

function statusBadgeClass(status: string): string {
  if (status === "VERIFIER_REJECTED") return "badge badge--bad";
  if (status === "SENT") return "badge badge--good";
  return "badge badge--neutral";
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters: OpportunityListFilters = {
    status: first(params.status) as OpportunityListFilters["status"],
    verifierResult: first(params.verifierResult) as OpportunityListFilters["verifierResult"],
    minScore: params.minScore ? Number(first(params.minScore)) : undefined,
    industry: first(params.industry) || undefined,
    country: first(params.country) || undefined,
    search: first(params.search) || undefined,
  };

  const db = getDb();
  const rows = listOpportunities(db, filters);

  return (
    <>
      <div className="page-header">
        <h1>Opportunities</h1>
        <p>{rows.length} matching opportunity(ies).</p>
      </div>

      <form method="get" className="filter-bar">
        <label>
          Search (company/domain)
          <input type="text" name="search" defaultValue={filters.search ?? ""} />
        </label>
        <label>
          Status
          <select name="status" defaultValue={filters.status ?? ""}>
            <option value="">Any</option>
            <option value="OPPORTUNITY_IDENTIFIED">OPPORTUNITY_IDENTIFIED</option>
            <option value="VERIFICATION_PENDING">VERIFICATION_PENDING</option>
            <option value="VERIFIER_REJECTED">VERIFIER_REJECTED</option>
            <option value="VERIFIED">VERIFIED</option>
            <option value="OFFER_READY">OFFER_READY</option>
            <option value="CONTACT_RESEARCH">CONTACT_RESEARCH</option>
            <option value="OUTREACH_READY">OUTREACH_READY</option>
            <option value="SENT">SENT</option>
          </select>
        </label>
        <label>
          Verifier result
          <select name="verifierResult" defaultValue={filters.verifierResult ?? ""}>
            <option value="">Any</option>
            <option value="KEEP">KEEP</option>
            <option value="REJECT">REJECT</option>
          </select>
        </label>
        <label>
          Min score
          <input type="number" name="minScore" min={0} max={100} defaultValue={filters.minScore ?? ""} />
        </label>
        <label>
          Industry
          <input type="text" name="industry" defaultValue={filters.industry ?? ""} />
        </label>
        <label>
          Country
          <input type="text" name="country" defaultValue={filters.country ?? ""} />
        </label>
        <button type="submit">Apply filters</button>
        <a href="/opportunities">Clear</a>
      </form>

      {rows.length === 0 ? (
        <p className="empty-state">No opportunities match these filters yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Problem</th>
              <th>Score</th>
              <th>Verifier</th>
              <th>Status</th>
              <th>Verdict</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/opportunities/${row.id}`}>{row.companyName}</Link>
                  <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {row.companyIndustry ?? "—"} · {row.companyCountry ?? "—"}
                  </div>
                </td>
                <td>{row.problemTitle}</td>
                <td>{row.adjustedScore ?? "—"}</td>
                <td>{row.verifierResult ?? "—"}</td>
                <td>
                  <span className={statusBadgeClass(row.status)}>{row.status}</span>
                </td>
                <td>
                  <span className={verdictBadgeClass(row.operatorVerdict)}>
                    {row.operatorVerdict}
                  </span>
                </td>
                <td>{formatDate(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
