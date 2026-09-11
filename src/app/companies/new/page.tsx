import { requestManualResearchAction } from "../../actions/companies";

export default function NewCompanyResearchPage() {
  return (
    <>
      <div className="page-header">
        <h1>Research a company</h1>
        <p>
          Enter a company&apos;s website. It proceeds through the same research, analysis,
          verification, offer, contact, and outreach pipeline as any autonomously discovered
          company (spec §72).
        </p>
      </div>

      <form action={requestManualResearchAction} className="field-grid">
        <label>
          Website
          <input type="url" name="website" placeholder="https://example.com" required />
        </label>
        <label>
          Name (optional)
          <input type="text" name="name" placeholder="Acme Plumbing" />
        </label>
        <button type="submit" className="primary">
          Research this company now
        </button>
      </form>
    </>
  );
}
