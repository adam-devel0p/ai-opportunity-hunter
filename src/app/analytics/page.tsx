import { getDb } from "../../lib/appDb";
import {
  getOverallOutcomeMetrics,
  getPerformanceByDimension,
  type DimensionPerformanceRow,
  type PerformanceDimension,
  type RateStat,
} from "../../lib/outcomeAnalytics";
import { formatPercent, formatScore } from "../format";

export const dynamic = "force-dynamic";

function RateCell({ stat }: { stat: RateStat }) {
  return (
    <td>
      {formatPercent(stat.rate)}
      {stat.denominator > 0 && !stat.reliable ? (
        <span className="badge badge--warn" style={{ marginLeft: 6 }}>
          low sample
        </span>
      ) : null}
    </td>
  );
}

const DIMENSIONS: { key: PerformanceDimension; label: string; valueLabel: string }[] = [
  { key: "industry", label: "Performance by industry", valueLabel: "Industry" },
  { key: "country", label: "Performance by country", valueLabel: "Country" },
  { key: "problemCategory", label: "Performance by problem category", valueLabel: "Problem category" },
  { key: "campaign", label: "Performance by campaign", valueLabel: "Campaign" },
  { key: "priceBand", label: "Performance by price band", valueLabel: "Price band" },
];

function DimensionTable({
  valueLabel,
  rows,
}: {
  valueLabel: string;
  rows: DimensionPerformanceRow[];
}) {
  if (rows.length === 0) {
    return <p className="empty-state">No outreach has been sent in this dimension yet.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>{valueLabel}</th>
          <th>Sent</th>
          <th>Reply rate</th>
          <th>Positive rate</th>
          <th>Meeting rate</th>
          <th>Win rate</th>
          <th>Avg. score</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.dimensionValue}>
            <td>{row.dimensionValue}</td>
            <td>{row.sentCount}</td>
            <RateCell stat={row.replyRate} />
            <RateCell stat={row.positiveReplyRate} />
            <RateCell stat={row.meetingRate} />
            <RateCell stat={row.winRate} />
            <td>{formatScore(row.averageScore.average)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AnalyticsPage() {
  const db = getDb();
  const overall = getOverallOutcomeMetrics(db);

  return (
    <>
      <div className="page-header">
        <h1>Outcome analytics</h1>
        <p>
          Simple statistical feedback from real outreach outcomes (spec §47/§74) — no machine
          learning, just rates and averages, hedged when the sample is too small to trust.
        </p>
      </div>

      <h2>Overall</h2>
      <div className="metrics-grid">
        <div className="metric-tile">
          <div className="metric-tile__value">{overall.sentCount}</div>
          <div className="metric-tile__label">Outreach sent</div>
        </div>
        <div className="metric-tile">
          <div className="metric-tile__value">
            {formatPercent(overall.replyRate.rate)}
            {overall.replyRate.denominator > 0 && !overall.replyRate.reliable ? " *" : ""}
          </div>
          <div className="metric-tile__label">Reply rate</div>
        </div>
        <div className="metric-tile">
          <div className="metric-tile__value">
            {formatPercent(overall.positiveReplyRate.rate)}
            {overall.positiveReplyRate.denominator > 0 && !overall.positiveReplyRate.reliable ? " *" : ""}
          </div>
          <div className="metric-tile__label">Positive reply rate</div>
        </div>
        <div className="metric-tile">
          <div className="metric-tile__value">
            {formatPercent(overall.meetingRate.rate)}
            {overall.meetingRate.denominator > 0 && !overall.meetingRate.reliable ? " *" : ""}
          </div>
          <div className="metric-tile__label">Meeting rate</div>
        </div>
        <div className="metric-tile">
          <div className="metric-tile__value">
            {formatPercent(overall.winRate.rate)}
            {overall.winRate.denominator > 0 && !overall.winRate.reliable ? " *" : ""}
          </div>
          <div className="metric-tile__label">Win rate</div>
        </div>
        <div className="metric-tile">
          <div className="metric-tile__value">{formatScore(overall.averageOpportunityScore.average)}</div>
          <div className="metric-tile__label">Average opportunity score</div>
        </div>
      </div>
      <p className="empty-state" style={{ marginTop: 4 }}>
        * fewer than 5 outreach attempts in this bucket — treat as anecdote, not signal.
      </p>

      <h2>Score vs. response</h2>
      <div className="metrics-grid">
        <div className="metric-tile">
          <div className="metric-tile__value">
            {formatScore(overall.scoreVsResponse.repliedAverageScore.average)}
          </div>
          <div className="metric-tile__label">
            Avg. score — replied ({overall.scoreVsResponse.repliedAverageScore.sampleSize})
          </div>
        </div>
        <div className="metric-tile">
          <div className="metric-tile__value">
            {formatScore(overall.scoreVsResponse.notRepliedAverageScore.average)}
          </div>
          <div className="metric-tile__label">
            Avg. score — no reply ({overall.scoreVsResponse.notRepliedAverageScore.sampleSize})
          </div>
        </div>
      </div>

      {DIMENSIONS.map(({ key, label, valueLabel }) => (
        <section key={key}>
          <h2>{label}</h2>
          <DimensionTable valueLabel={valueLabel} rows={getPerformanceByDimension(db, key)} />
        </section>
      ))}
    </>
  );
}
