import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/appDb";
import { getCompanyDetail } from "../../../lib/dashboardQueries";
import { formatDate } from "../../format";

export const dynamic = "force-dynamic";

const QUEUED_MESSAGES: Record<string, string> = {
  queued: "Queued for research — the worker will pick this up next cycle.",
  "already-queued": "Already queued for research.",
  "already-progressed": "This company has already moved past the research stage — see below.",
};

export default async function CompanyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const db = getDb();
  const detail = getCompanyDetail(db, id);
  if (!detail) notFound();

  const { company, opportunities } = detail;
  const queuedMessage = typeof query.queued === "string" ? QUEUED_MESSAGES[query.queued] : undefined;

  return (
    <>
      <div className="page-header">
        <h1>{company.name}</h1>
        <p>
          <a href={company.website} target="_blank" rel="noreferrer">
            {company.website}
          </a>{" "}
          · {company.country ?? "unknown country"} · {company.industry ?? "unknown industry"}
        </p>
      </div>

      {queuedMessage && <div className="flash flash--info">{queuedMessage}</div>}

      <div className="card">
        <div className="action-row" style={{ marginBottom: 8 }}>
          <span className="badge badge--neutral">{company.lifecycleStatus}</span>
          {company.doNotContact && <span className="badge badge--bad">DO NOT CONTACT</span>}
        </div>
        {company.description && <p>{company.description}</p>}
        <p style={{ color: "var(--text-muted)" }}>
          First discovered {formatDate(company.firstDiscoveredAt)} · Last discovered{" "}
          {formatDate(company.lastDiscoveredAt)}
          {company.lastResearchedAt ? ` · Last researched ${formatDate(company.lastResearchedAt)}` : ""}
        </p>
      </div>

      {company.notes && (
        <div className="card">
          <h3>Notes / pipeline trail</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{company.notes}</p>
        </div>
      )}

      <h2>Opportunities</h2>
      {opportunities.length === 0 ? (
        <p className="empty-state">No opportunity formed for this company yet.</p>
      ) : (
        <ul>
          {opportunities.map((opp) => (
            <li key={opp.id}>
              <Link href={`/opportunities/${opp.id}`}>{opp.problemTitle}</Link> —{" "}
              <span className="badge badge--neutral">{opp.status}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
