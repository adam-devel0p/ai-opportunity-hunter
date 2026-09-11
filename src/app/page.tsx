import { getDb } from "../lib/appDb";
import { getAutonomousMode } from "../lib/config";
import { getRecentActivity } from "../lib/activity";
import { getSummaryMetrics } from "../lib/dashboardQueries";
import { toggleAutonomousMode } from "./actions/autonomous";
import { formatDateTime } from "./format";

export const dynamic = "force-dynamic";

const METRIC_LABELS: { key: keyof ReturnType<typeof getSummaryMetrics>; label: string }[] = [
  { key: "companiesDiscovered", label: "Companies discovered" },
  { key: "companiesScreened", label: "Companies screened" },
  { key: "companiesAwaitingResearch", label: "Awaiting research" },
  { key: "companiesResearched", label: "Deeply researched" },
  { key: "opportunitiesGenerated", label: "Opportunities generated" },
  { key: "strongOpportunities", label: "Strong opportunities" },
  { key: "opportunitiesRejected", label: "Opportunities rejected" },
  { key: "outreachDraftsReady", label: "Outreach drafts ready" },
  { key: "manuallySentOutreach", label: "Manually sent" },
  { key: "replies", label: "Replies" },
  { key: "interestedReplies", label: "Interested replies" },
  { key: "meetings", label: "Meetings" },
  { key: "wonDeals", label: "Won deals" },
  { key: "lostDeals", label: "Lost deals" },
];

export default function DashboardPage() {
  const db = getDb();
  const metrics = getSummaryMetrics(db);
  const autonomousEnabled = getAutonomousMode(db);
  const activity = getRecentActivity(db, 30);

  return (
    <>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Autonomous discovery-to-outreach pipeline at a glance.</p>
      </div>

      <div className="card">
        <div className="action-row">
          <span>
            Autonomous research is currently{" "}
            <strong>{autonomousEnabled ? "RUNNING" : "PAUSED"}</strong>.
          </span>
          <form action={toggleAutonomousMode}>
            <button type="submit" className={autonomousEnabled ? "danger" : "primary"}>
              {autonomousEnabled ? "Pause autonomous research" : "Resume autonomous research"}
            </button>
          </form>
        </div>
      </div>

      <h2>Summary</h2>
      <div className="metrics-grid">
        {METRIC_LABELS.map(({ key, label }) => (
          <div className="metric-tile" key={key}>
            <div className="metric-tile__value">{metrics[key]}</div>
            <div className="metric-tile__label">{label}</div>
          </div>
        ))}
      </div>

      <h2>Recent activity</h2>
      {activity.length === 0 ? (
        <p className="empty-state">
          Nothing has run yet. Enable autonomous research above, or{" "}
          <a href="/companies/new">research a company manually</a>.
        </p>
      ) : (
        <ul className="activity-feed">
          {activity.map((entry) => (
            <li key={`${entry.workItemId}-${entry.timestamp.getTime()}`} className={entry.level}>
              <time dateTime={entry.timestamp.toISOString()}>{formatDateTime(entry.timestamp)}</time>
              <span>{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
