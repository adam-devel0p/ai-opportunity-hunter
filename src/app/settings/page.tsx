import { getDb } from "../../lib/appDb";
import { listExclusionRules } from "../../lib/exclusions";
import { getOpportunityGateConfig, getReResearchWindowMs } from "../../lib/config";
import { EXPORT_ENTITIES } from "../../lib/exportData";
import {
  addExclusionRuleAction,
  createBackupAction,
  removeExclusionRuleAction,
  updateOpportunityGateConfigAction,
  updateReResearchWindowAction,
} from "../actions/settings";

export const dynamic = "force-dynamic";

const EXCLUSION_TYPES = ["DOMAIN", "INDUSTRY", "COUNTRY"] as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const db = getDb();
  const rules = listExclusionRules(db);
  const gateConfig = getOpportunityGateConfig(db);
  const windowDays = Math.round(getReResearchWindowMs(db) / (24 * 60 * 60 * 1000));
  const backupPath = typeof query.backup === "string" ? query.backup : undefined;

  return (
    <>
      <div className="page-header">
        <h1>Settings</h1>
        <p>Operator controls beyond autonomous on/off (spec §61, §70, §79-80).</p>
      </div>

      {backupPath && (
        <div className="flash flash--info">Backup created at {backupPath}.</div>
      )}

      <h2>Exclusions (spec §61)</h2>
      <div className="card">
        <p style={{ color: "var(--text-muted)" }}>
          A domain, industry, or country matching one of these rules is excluded before spending
          any Claude call — checked at discovery time and again, live, right before every
          pre-screen. To exclude one specific company permanently, use the &ldquo;Exclude
          company&rdquo; button on its own page instead.
        </p>
        <form action={addExclusionRuleAction} className="action-row" style={{ marginTop: 10 }}>
          <select name="type" required defaultValue="">
            <option value="" disabled>
              Type…
            </option>
            {EXCLUSION_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <input type="text" name="value" placeholder="e.g. example.com / gambling / RU" required />
          <input type="text" name="reason" placeholder="Reason (optional)" />
          <button type="submit" className="primary">
            Add rule
          </button>
        </form>

        {rules.length === 0 ? (
          <p className="empty-state">No exclusion rules yet.</p>
        ) : (
          <ul style={{ marginTop: 10 }}>
            {rules.map((rule) => (
              <li key={rule.id} className="action-row">
                <span className="badge badge--neutral">{rule.type}</span>
                <span>{rule.value}</span>
                {rule.reason && <span style={{ color: "var(--text-muted)" }}>— {rule.reason}</span>}
                <form action={removeExclusionRuleAction}>
                  <input type="hidden" name="id" value={rule.id} />
                  <button type="submit" className="danger">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2>Strong-opportunity gate (spec §32, §70)</h2>
      <div className="card">
        <form action={updateOpportunityGateConfigAction} className="field-grid">
          <label>
            Score threshold (0-100)
            <input type="number" name="scoreThreshold" defaultValue={gateConfig.scoreThreshold} min={0} max={100} />
          </label>
          <label>
            Evidence strength floor (0-20)
            <input
              type="number"
              name="evidenceStrengthFloor"
              defaultValue={gateConfig.evidenceStrengthFloor}
              min={0}
              max={20}
            />
          </label>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="allowHighRisk" defaultChecked={gateConfig.allowHighRisk} />
            Allow high-risk decision domains (spec §8) — requires explicit review
          </label>
          <button type="submit" className="primary">
            Save gate config
          </button>
        </form>
      </div>

      <h2>Re-research interval (spec §60, §70)</h2>
      <div className="card">
        <form action={updateReResearchWindowAction} className="action-row">
          <label>
            Days before a researched company becomes eligible for evidence refresh
            <input type="number" name="windowDays" defaultValue={windowDays} min={1} required />
          </label>
          <button type="submit" className="primary">
            Save
          </button>
        </form>
      </div>

      <h2>Backup (spec §80)</h2>
      <div className="card">
        <form action={createBackupAction}>
          <button type="submit" className="primary">
            Create backup now
          </button>
        </form>
        <p style={{ color: "var(--text-muted)", marginTop: 8 }}>
          Writes a point-in-time copy to <code>./data/backups/</code>. Restore with{" "}
          <code>npm run backup -- restore &lt;path&gt;</code> (stop the worker/dashboard first).
        </p>
      </div>

      <h2>Export (spec §79)</h2>
      <div className="card">
        <p>
          <a href="/api/export?format=json">Download everything as JSON</a>
        </p>
        <p style={{ color: "var(--text-muted)" }}>Or per-entity CSV:</p>
        <ul>
          {EXPORT_ENTITIES.map((entity) => (
            <li key={entity}>
              <a href={`/api/export?format=csv&entity=${entity}`}>{entity}.csv</a>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
