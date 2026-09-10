# AI Opportunity Hunter

## Comprehensive Product & System Requirements

### Document purpose

This document defines the complete product vision, behavioral requirements, constraints, data requirements, agent responsibilities, research standards, user experience, and success criteria for a personal AI-powered business opportunity discovery system.

This is a **requirements specification, not an implementation plan**.

The implementation should later be broken into small, independently executable phases that can be implemented across separate Claude Code sessions. Do not prematurely simplify requirements merely to make the initial implementation easier. Instead, identify which requirements belong in MVP, which belong in later phases, and design the architecture so later capabilities can be added without a major rewrite.

The system is intended initially for a **single user/operator**.

---

# 1. Product name

Working name:

**AI Opportunity Hunter**

Alternative internal names such as Opportunity Engine, Business Scout, or AI Sales Researcher are acceptable in code, but this document refers to the system as AI Opportunity Hunter.

---

# 2. Product vision

Build a continuously operating personal AI system that searches the public internet for real small and medium-sized businesses, deeply researches those businesses, identifies real and economically meaningful problems they appear to have, determines whether the operator could realistically solve those problems using software, AI, automation, existing APIs, SaaS tools, or lightweight custom development, and turns the strongest findings into concrete sales opportunities.

The system must not simply generate lists of companies.

The system must answer:

**“Which real business appears to have a real problem that I can realistically solve, why do we believe the problem exists, what is it probably worth to them, what should I offer them, who should I contact, and what should I say?”**

The final output should be a small number of **high-confidence actionable opportunities**, rather than thousands of generic leads.

The operator manually reviews every opportunity and manually sends outreach.

Automatic email sending is explicitly not part of the initial product.

---

# 3. Primary objective

The objective is NOT:

> Generate as many leads as possible.

The objective IS:

> Continuously identify evidence-backed situations where a business plausibly has a meaningful problem, the operator can realistically solve that problem quickly, the value of solving it significantly exceeds the proposed price, and there is a reachable decision-maker who could reasonably purchase the solution.

The system should strongly prefer returning:

**NO OPPORTUNITY**

rather than inventing, exaggerating, or weakly inferring one.

Accuracy and economic usefulness are more important than volume.

---

# 4. Operator context

The system should understand the operator's delivery capabilities when evaluating opportunities.

The operator is an experienced software engineer capable of rapidly delivering solutions with assistance from Claude and modern development tools.

Relevant capabilities include:

* web applications
* internal dashboards
* workflow automation
* AI-assisted workflows
* email automation
* CRM integration
* API integration
* data extraction
* PDF/document processing
* OCR when appropriate
* classification and routing
* customer intake
* customer support tooling
* RAG / knowledge retrieval
* internal search
* booking and scheduling workflows
* candidate intake workflows
* reporting systems
* simple portals
* document generation
* data reconciliation
* integrations between existing SaaS tools
* lightweight backend services
* browser-based automation where appropriate
* simple mobile/web interfaces
* data transformation
* translation/localization workflows
* operational AI assistants

Claude may be used heavily to accelerate implementation.

The preferred opportunity should normally be something one technically competent person can implement in approximately:

**a few hours to five working days.**

Opportunities requiring larger projects may still be recorded, but should generally rank below small, fast, high-value interventions.

---

# 5. Business model being supported

The initial business model is:

**Find a problem first, then sell the solution.**

The operator does not initially need to choose a specific niche or a single fixed service.

The system should search across industries and allow actual market response to reveal:

* which industries respond
* which problems occur repeatedly
* which offers produce conversations
* which solutions are easiest to sell
* which solutions are easiest to deliver
* where willingness to pay is highest

Over time, these results may reveal a repeatable consulting service, productized service, automation package, or SaaS opportunity.

The system is therefore both:

**a customer acquisition engine**

and

**a market/problem discovery engine.**

---

# 6. Initial target market

The initial focus is small and medium-sized businesses operating substantially in English.

Default company size preference:

**approximately 2–100 employees**

This range must eventually be configurable rather than hard-coded.

The system may research businesses in locations including:

* United States
* United Kingdom
* Ireland
* Canada
* Australia
* New Zealand
* Singapore
* other countries where the company operates commercially in English

A company's physical country does not need to be English-speaking if its business operates primarily in English and the operator could reasonably sell to it remotely.

The system should avoid very large enterprises by default because procurement, security reviews, vendor onboarding, and buying cycles are likely to be slower.

The system should also avoid extremely small businesses where the economic value of the proposed solution is unlikely to justify the price.

Both rules should be heuristics rather than absolute exclusions.

---

# 7. Initial industry strategy

The system should NOT permanently lock itself to one industry.

Instead it should continuously create and test discovery campaigns.

Examples:

`UK + recruitment agencies`

`Australia + property management`

`USA + accounting firms`

`Ireland + logistics companies`

`Canada + ecommerce companies`

`New Zealand + tour operators`

`Singapore + recruitment businesses`

Campaign generation should eventually become partly autonomous.

The system should intentionally diversify discovery until response data demonstrates that particular industries or opportunity types deserve more attention.

---

# 8. Industries requiring caution

Initially reduce priority or exclude opportunities involving high-risk decisions in areas such as:

* medical diagnosis
* treatment recommendations
* legal advice
* credit decisions
* insurance underwriting
* automated employment decisions with significant legal consequences
* financial trading
* highly sensitive regulated personal information
* surveillance
* safety-critical systems

Businesses in healthcare, finance, legal services, etc. are not necessarily completely excluded.

However, proposed solutions for such businesses should avoid high-risk decision-making unless explicitly reviewed by the operator.

For example, automating appointment intake for a clinic may be reasonable while automatically diagnosing patients is not.

Risk should be represented explicitly in opportunity scoring.

---

# 9. Fundamental system architecture

The system should behave like multiple specialized workers operating over a shared persistent database.

Conceptually:

DISCOVERY
→ PRE-SCREENING
→ DEEP RESEARCH
→ OPPORTUNITY ANALYSIS
→ SKEPTICAL VERIFICATION
→ OFFER CREATION
→ CONTACT RESEARCH
→ OUTREACH DRAFT
→ HUMAN REVIEW
→ MANUAL SENDING
→ RESPONSE/OUTCOME FEEDBACK

The database is the long-term memory.

Claude conversations are NOT the long-term memory.

Individual Claude tasks should preferably receive only the information necessary to perform their particular job.

Avoid one enormous permanent Claude conversation containing hundreds of researched businesses.

---

# 10. Claude usage constraint

A major project requirement is:

**The system must use the operator's existing Claude subscription allowance wherever currently supported rather than intentionally using pay-as-you-go Anthropic API billing.**

The implementation must therefore avoid silently falling back to an Anthropic API key.

The system must not require an `ANTHROPIC_API_KEY` for normal subscription-backed operation.

Before implementation, verify Anthropic's current supported mechanism for programmatically using subscription-authenticated Claude.

At the time this specification was created, Claude Code non-interactive usage and Claude Agent SDK subscription-backed usage were available under current Anthropic policy. Anthropic has changed or proposed changes to this behavior previously, so the implementation plan must verify current official documentation before selecting the final mechanism.

Preferred possibilities include:

* Claude Agent SDK using subscription authentication
* subscription-authenticated Claude Code
* `claude -p`
* another officially supported subscription-authenticated Anthropic mechanism

Do not circumvent Anthropic usage restrictions.

Do not imitate browser sessions or scrape Claude's website to obtain free model calls.

Do not enable API-credit fallback without explicit operator action.

---

# 11. Local-first requirement

Initial operation should be local.

Preferred environment:

* macOS
* operator's MacBook
* Node.js / TypeScript
* local database
* local web dashboard
* Claude Code / Agent SDK
* local scheduler

The system should be capable of running while the laptop is awake.

Cloud hosting is not required for MVP.

The architecture should not prevent eventual migration to:

* VPS
* PostgreSQL
* hosted dashboard
* managed scheduling

but this should not complicate the initial version.

---

# 12. Preferred technical direction

Unless implementation planning reveals a strong reason otherwise, prefer:

**Language:** TypeScript

**Runtime:** Node.js

**UI:** Next.js

**Database initially:** SQLite

**ORM:** Prisma or Drizzle

**LLM/agent layer:** Claude Agent SDK or another officially supported subscription-backed Claude Code interface

**Scheduling:** lightweight local scheduler / macOS launch mechanism / Node scheduling mechanism

Avoid unnecessary infrastructure.

Do NOT introduce by default:

* Kafka
* Kubernetes
* distributed microservices
* complex event infrastructure
* multiple databases
* enterprise message queues
* unnecessary Docker orchestration

This is initially a one-user personal application.

---

# 13. Core operating principle: cheap filtering before expensive research

Claude usage is limited.

Therefore the system must progressively invest more research effort only in promising companies.

Conceptual funnel:

100 companies discovered

↓

fast/cheap screening

↓

perhaps 20–40 potentially relevant

↓

deeper research on perhaps 10–20

↓

several plausible problems

↓

skeptical verification

↓

perhaps 1–5 high-quality opportunities

Exact numbers should not be hard-coded.

The important principle is:

**Do not deeply research every discovered company.**

---

# 14. Discovery Agent

The Discovery Agent's responsibility is to identify real businesses that may be worth screening.

It should NOT attempt full business diagnosis during discovery.

For each discovered business, capture at minimum:

* canonical company name
* website
* normalized domain
* country/location
* industry/category
* short description
* approximate company size if available
* discovery source
* discovery date
* reason it may be worth screening
* discovery campaign that found it

Businesses must be real.

The Discovery Agent must never invent company names, URLs, locations, or descriptions.

---

# 15. Autonomous discovery campaigns

The system should maintain the concept of a **Discovery Campaign**.

A campaign can contain criteria such as:

* geography
* industry
* company size
* keywords
* business model
* service type
* opportunity hypothesis

Examples:

`UK recruitment agencies with 5–50 employees`

`Australian property managers`

`small US logistics companies`

The system should initially support manually configured campaigns.

It should later support Claude suggesting or generating new campaigns.

Autonomously generated campaigns should not permanently replace operator control.

The operator should be able to:

* enable
* disable
* pause
* prioritize
* blacklist
* inspect

campaigns.

---

# 16. Discovery diversity

The system should avoid spending all available research capacity on one sector simply because it discovered that sector first.

Before sufficient outcome data exists, discovery should intentionally maintain reasonable diversity across:

* industries
* countries
* company sizes
* business models
* opportunity categories

Once actual response/sales data accumulates, allocation may increasingly favor higher-performing combinations.

---

# 17. Domain normalization and company deduplication

Companies must have a canonical normalized identity.

URLs such as:

`https://www.example.com`

`http://example.com/`

`https://example.com/about`

should resolve to the same company/domain identity where appropriate.

The system should normalize:

* protocol
* `www`
* trailing path
* query parameters
* casing where appropriate
* redirects where reliable

The database should prevent repeated unnecessary discovery and research of the same business.

However, companies should be eligible for re-research after a configurable period or when meaningful new information appears.

---

# 18. Pre-Screening Agent

The Pre-Screening Agent performs relatively inexpensive evaluation.

Typical pages may include:

* homepage
* services
* about
* contact
* pricing
* booking
* careers

The objective is NOT to diagnose the company fully.

The objective is to determine whether spending more research capacity is justified.

Suggested output classifications:

**DISCARD**

**MAYBE**

**PROMISING**

The system should record why.

Examples of reasons for rejection:

* business inactive
* website unavailable
* company too large
* company too small
* unclear commercial operation
* clearly unsuitable target
* no plausible software/automation relevance
* language mismatch
* previously researched recently
* duplicate business

---

# 19. Deep Research Agent

Companies passing screening become eligible for deep research.

This agent is the most important research component.

Its responsibility is to understand how the business appears to operate and find **observable signals of expensive friction, lost revenue, manual effort, poor customer experience, operational bottlenecks, or repetitive work.**

The agent should investigate relevant public information dynamically rather than mechanically reading exactly the same sources for every company.

Potential sources include:

* homepage
* service pages
* product pages
* pricing pages
* contact pages
* quote request flows
* signup flows
* booking process
* support pages
* FAQ
* documentation
* customer portal information
* blog posts
* case studies
* public careers pages
* current job vacancies
* public company profiles
* public reviews
* public social content
* public announcements
* recent news
* public discussions
* software review sites where relevant
* competitor websites
* technology information where legitimately available
* public directories
* relevant Reddit discussions when appropriate

Not every company requires every source.

Claude should determine which research paths are useful.

---

# 20. Research must be problem-oriented, not AI-oriented

The research agent must NOT operate under:

> Find something where we could add AI.

Instead:

> Find meaningful business problems.

The eventual solution may contain:

* AI
* ordinary software
* automation
* integration
* simple scripting
* better workflow
* existing SaaS
* no AI at all

The business should be sold an outcome, not technology for its own sake.

---

# 21. Fact / inference / hypothesis separation

This is a critical requirement.

Every meaningful research statement must be categorized as one of:

### FACT

Directly supported by a public source.

Example:

“Candidates are instructed to email their CV to [recruitment@example.com](mailto:recruitment@example.com).”

### INFERENCE

Reasonable conclusion based on one or more facts but not directly established.

Example:

“Candidate intake may require manual processing.”

### HYPOTHESIS

A possibility worth validating with the company.

Example:

“The recruiting team may spend several hours each week manually categorizing applications.”

### UNKNOWN

Information necessary to evaluate the opportunity but not currently established.

Example:

“Actual weekly applicant volume is unknown.”

The system must NEVER silently convert inference or hypothesis into fact.

---

# 22. Evidence requirement

Every proposed opportunity must contain evidence.

At minimum, evidence should contain:

* claim
* evidence type
* source URL
* source title where available
* retrieval timestamp
* concise supporting excerpt or summary
* confidence

The system should preserve enough provenance that the operator can click the source and independently verify the research.

Evidence should preferably come from multiple independent sources when the claim is important.

---

# 23. Source snapshots and freshness

Websites change.

Therefore research records must include retrieval timestamps.

The system should distinguish between:

* recent evidence
* stale evidence
* unavailable evidence

Before drafting outreach from older research, the system should eventually be capable of rechecking the most important claims.

Do not assume that evidence collected months ago remains valid.

The exact freshness thresholds should be configurable or decided during implementation planning.

---

# 24. Research integrity

Agents must obey the following rules:

Do not invent facts.

Do not invent quotes.

Do not invent employee counts.

Do not invent revenue.

Do not invent technologies.

Do not invent customer volumes.

Do not invent staff workload.

Do not invent emails.

Do not claim that something is manual merely because automation is not visible.

Do not claim a business lacks a system merely because the system is not publicly visible.

Do not claim a financial loss unless there is supporting evidence.

When information cannot be established, record it as unknown.

---

# 25. Problem categories

Maintain an extensible library of common opportunity categories.

Examples include:

* lead qualification
* customer enquiry handling
* document processing
* customer intake
* support automation
* booking
* scheduling
* quote generation
* sales follow-up
* email classification/routing
* reporting
* invoice processing
* reconciliation
* CRM data entry
* candidate intake
* candidate screening support
* knowledge retrieval
* internal search
* onboarding
* compliance paperwork
* content transformation
* translation
* data extraction
* customer self-service
* maintenance request routing
* order handling
* inventory/admin workflows
* review/reputation workflows
* repetitive internal communication

This library is inspiration.

Claude must remain capable of discovering novel problems outside the predefined categories.

---

# 26. Opportunity Analysis Agent

Once research is complete, a separate logical component analyzes whether a commercial opportunity exists.

The core question is:

**What expensive or valuable problem does this business plausibly have that the operator can realistically solve?**

An opportunity must include:

* clear problem statement
* relevant facts
* relevant inferences
* unresolved unknowns
* economic consequence
* likely affected role/team
* proposed solution
* why the solution fits
* expected business benefit
* implementation complexity
* approximate implementation time
* dependencies
* likely risks
* possible existing alternatives
* confidence
* suggested price
* suggested commercial model
* proposed validation question
* opportunity score

---

# 27. Deliverability requirement

The proposed solution must be realistically deliverable by the operator.

Prefer solutions that can be implemented using:

* existing APIs
* existing SaaS
* Claude
* simple custom backend/frontend work
* integrations
* workflow engines
* browser automation where legitimate
* lightweight databases
* existing communication platforms
* existing cloud services

Avoid recommending:

* massive ERP replacements
* multi-year transformations
* mission-critical infrastructure rewrites
* projects requiring a large team
* projects requiring extensive enterprise procurement
* integrations that cannot reasonably be accessed
* speculative technology with unclear feasibility

---

# 28. Value requirement

An opportunity is not attractive simply because it is technically possible.

The agent must ask:

**Why would the company pay for this?**

Potential value sources include:

* staff hours saved
* faster lead response
* higher conversion
* fewer lost enquiries
* less repetitive work
* fewer mistakes
* shorter processing time
* lower support volume
* improved customer experience
* increased capacity without hiring
* reduced administrative workload
* improved data quality
* improved response speed
* improved visibility/reporting
* reduced operational friction

Whenever value is estimated rather than known, assumptions must be explicit.

---

# 29. ROI model

Where possible, the system should create a lightweight ROI model.

Example:

Assumption:

2 employees

× 5 hours/week

× €30/hour loaded labor cost

= approximately €1,200/month effort.

Potential reduction:

40%

≈ €480/month estimated saving.

The system must clearly distinguish:

**known values**

from

**assumptions.**

Do not present hypothetical ROI as fact.

The purpose is to determine whether a €500–€2,000 project appears economically sensible.

---

# 30. Opportunity scoring

Every opportunity should receive a transparent score.

Suggested base scoring:

Evidence strength: 0–20

Pain severity: 0–15

Estimated economic impact: 0–15

Operator deliverability: 0–15

Likelihood company would purchase: 0–10

Speed to business value: 0–5

Decision-maker reachability: 0–5

Ability to demonstrate solution: 0–5

Repeatability / future revenue: 0–5

Urgency/timing: 0–5

Maximum:

**100**

Scoring components must remain visible rather than only storing the final number.

---

# 31. Opportunity penalties

Potential penalties should also exist.

Examples:

Weak/speculative evidence.

Commodity solution already easily available.

Problem appears already solved.

Large procurement burden.

Significant regulatory risk.

Unclear buyer.

Implementation dependency outside operator control.

Company appears financially unsuitable.

Long implementation cycle.

Extremely crowded generic offer.

The exact numerical penalties may be determined in implementation planning.

---

# 32. Strong opportunity gating

A prospect should only reach the primary operator dashboard as a **Strong Opportunity** when it satisfies configurable requirements such as:

* sufficient evidence score
* sufficient overall score
* acceptable implementation risk
* no serious unsupported claims
* skeptical reviewer returns KEEP
* proposed solution is realistically deliverable

Initial target threshold:

**approximately 75/100**

This should eventually be configurable.

---

# 33. Skeptical Verification Agent

A separate Claude evaluation must attempt to disprove promising opportunities.

It should receive the research and proposal but preferably operate with fresh context.

Its responsibility is NOT to improve the sales pitch.

Its responsibility is to find reasons the opportunity is bad.

Questions include:

* Is the evidence actually sufficient?
* Is the main problem inferred rather than demonstrated?
* Is there an obvious existing solution?
* Does the business already appear to use such a system?
* Is the benefit too small?
* Is the company too small?
* Is the company too sophisticated?
* Is integration likely impossible?
* Are regulatory/security requirements disproportionate?
* Is the price unrealistic?
* Would the buyer care?
* Is the operator capable of delivering it?
* Is the problem merely cosmetic?
* Is this another generic “AI chatbot” idea?
* Is there evidence of urgency?
* Is there a much cheaper off-the-shelf alternative?

Output should include:

**KEEP**

or

**REJECT**

plus:

* adjusted score
* confidence
* weaknesses
* unsupported assumptions
* missing information
* potential deal killers

The system should be deliberately biased toward rejecting mediocre opportunities.

---

# 34. Offer Builder

Only opportunities surviving verification should proceed to offer creation.

The offer must define an actual deliverable.

A valid offer should contain:

* problem being addressed
* proposed solution
* specific scope
* expected business outcome
* key assumptions
* expected implementation duration
* suggested price
* optional recurring charge where justified
* what is excluded
* what needs validation
* low-risk proof/demo concept
* reason the offer is commercially attractive

Avoid vague offers such as:

> AI automation services.

Prefer:

> Automated applicant intake workflow that extracts candidate details, checks them against role requirements, and creates a structured recruiter review queue.

---

# 35. Initial pricing framework

Suggested starting bands:

### Micro Fix

Approximately €150–€400.

Typically several hours.

### Small Automation

Approximately €400–€900.

Approximately half a day to one day.

### Workflow Implementation

Approximately €900–€2,000.

Approximately one to three days.

### Larger Small-Business Implementation

Approximately €2,000–€5,000.

Approximately three to seven days.

### Optional Ongoing Support

Approximately €50–€500/month where genuine ongoing value/cost exists.

These numbers should be configurable.

The system must not blindly maximize price.

The price should reflect:

* likely value
* implementation effort
* uncertainty
* market/business size
* support burden
* sales friction
* risk

Early opportunities may intentionally favor easier-to-buy €300–€1,500 offers.

---

# 36. Proof-of-value / demo strategy

For strong opportunities, ask:

**Can the operator demonstrate part of the solution before asking for a purchase?**

Possible demo concepts:

* dummy invoice processor
* sample CV qualification workflow
* mock enquiry responder
* sample dashboard
* automated document extraction
* prototype booking experience
* example reporting system
* small interactive proof

The system should describe a potential demo.

However:

**Do not claim a demo has been built unless it actually exists.**

Later versions may optionally generate demos automatically, but automatic demo creation is not required for initial MVP.

---

# 37. Contact Research Agent

Contact discovery must occur only after a business has a sufficiently strong opportunity.

Do not waste research capacity finding employees for businesses with no credible sales opportunity.

Preferred contact roles depend on the problem but may include:

* owner
* founder
* managing director
* operations director
* head of operations
* relevant department head
* commercial director
* technical owner
* practice manager
* recruitment director
* customer service lead

The system should identify the person most likely to own the pain/problem.

---

# 38. Contact evidence and confidence

For contacts, store:

* name
* role/title
* company
* source
* public profile URL
* email if publicly available
* email source
* email confidence
* verification status

Emails must be classified appropriately.

Possible states:

**PUBLICLY_LISTED**

**VERIFIED**

**GUESSED**

**UNKNOWN**

The system must NEVER represent a guessed email as verified.

Initial outreach should strongly prefer publicly listed or independently verified addresses.

---

# 39. Outreach Writer

For a strong verified opportunity with a reasonable contact, generate one primary cold outreach email.

The email should be concise.

Preferred length:

approximately 60–130 words.

The email should:

* reference a genuine company-specific observation
* describe the possible problem without pretending unverified assumptions are facts
* propose a specific solution
* communicate the likely benefit
* use simple language
* make a low-friction call to action
* sound like a competent individual, not an AI agency
* avoid exaggerated marketing language

Avoid phrases such as:

“revolutionary AI solution”

“transform your business with cutting-edge AI”

“unlock the power of AI”

and generic mass-email language.

---

# 40. Outreach truthfulness

Outreach must not contain false personalization.

It must not say:

“I noticed your team spends hours doing X”

unless evidence supports that.

Instead:

“I noticed candidates are currently directed to submit their CVs by email. If the first sorting step is still being done manually, I think there may be an easy automation opportunity.”

Likewise, never say:

“I built a demo”

unless a demo actually exists.

Never fabricate:

* customer references
* previous implementations
* testimonials
* case studies
* metrics
* savings
* company knowledge

---

# 41. Manual sending requirement

MVP must NOT automatically send outreach.

The workflow ends at:

**Draft Ready For Review**

The operator manually:

* opens the opportunity
* checks the evidence
* reviews the contact
* edits the email if desired
* copies it
* sends it manually

The UI may later allow the operator to mark it as SENT.

Future email integration may be added only deliberately.

---

# 42. Opportunity Dashboard

Build a local dashboard optimized around reviewing opportunities.

Primary dashboard should show summary metrics such as:

* companies discovered
* companies screened
* companies awaiting research
* companies deeply researched
* opportunities generated
* opportunities rejected
* strong opportunities
* outreach drafts ready
* manually sent outreach
* replies
* interested replies
* meetings
* won deals
* lost deals

---

# 43. Opportunity card

Each strong opportunity should display at minimum:

Company.

Website.

Country.

Industry.

Approximate size if known.

Overall opportunity score.

Verifier decision.

Problem.

Why it matters.

Evidence.

Facts.

Inferences.

Unknowns.

Estimated economic impact.

Proposed solution.

Implementation estimate.

Suggested price.

Potential recurring revenue.

Demo concept.

Risks.

Skeptical reviewer findings.

Suggested decision-maker.

Contact evidence.

Draft email.

Relevant source links.

---

# 44. Evidence UX

The operator must be able to understand exactly why Claude believes something.

Evidence should not be hidden behind a generic AI summary.

For major claims, show:

Claim.

Type:

FACT / INFERENCE / HYPOTHESIS / UNKNOWN.

Source.

Retrieval date.

Confidence.

The operator should be able to click the source.

---

# 45. Operator actions

At minimum support:

**Approve / Good Opportunity**

**Reject / Bad Opportunity**

**Draft Reviewed**

**Sent Manually**

**Got Reply**

**No Reply**

**Interested**

**Not Interested**

**Meeting**

**Won**

**Lost**

Relevant statuses should support optional notes.

---

# 46. Rejection reasons

When rejecting an opportunity, allow reasons such as:

* weak evidence
* bad problem
* wouldn't buy
* too difficult
* too small
* too large
* already solved
* poor contact
* bad price
* regulatory risk
* generic idea
* not interesting
* other

This feedback will eventually improve future opportunity ranking.

---

# 47. Feedback and learning

The system must preserve outcome data.

For example:

industry → outreach sent → reply → interested → meeting → won.

Opportunity category → reply rate.

Country → reply rate.

Price band → interested rate.

Problem category → conversion.

Company size → conversion.

Discovery campaign → conversion.

Eventually Claude should analyze outcomes and recommend discovery allocation changes.

Example:

Property management:

14% reply rate.

7% interest.

Recruitment:

9% reply.

3% interest.

Restaurants:

1% reply.

0% interest.

The system could then suggest allocating more discovery capacity to property management.

Do not implement complex machine learning initially.

Simple statistical feedback and Claude analysis are sufficient.

---

# 48. Research queue

All autonomous work should use a persistent queue or equivalent state-based workflow.

Possible work types:

DISCOVER

PRESCREEN

RESEARCH

ANALYZE

VERIFY

BUILD_OFFER

FIND_CONTACT

WRITE_OUTREACH

REFRESH_EVIDENCE

Each task should have states such as:

PENDING

RUNNING

COMPLETED

FAILED

DEFERRED

RETRYABLE

CANCELLED

Exact names may vary.

Persistent state is important so the system can resume after interruption.

---

# 49. Priority system

Claude quota should be spent according to commercial value.

Priority should generally be:

1. finish verification of very strong opportunities

2. finish offers for verified opportunities

3. find contacts for verified opportunities

4. prepare outreach for strong opportunities

5. complete deep research on promising businesses

6. pre-screen existing discoveries

7. discover additional companies

Discovery should be the lowest-value use of scarce quota when stronger unfinished work already exists.

---

# 50. Autonomous scheduler

The system should be able to operate opportunistically every day while the machine is available.

Conceptually:

Check whether autonomous operation is enabled.

Check outstanding high-priority work.

Check Claude availability/quota state.

Select highest-value eligible task.

Execute one bounded task.

Persist the result.

Continue while resources permit.

When Claude usage limits prevent further work:

* stop gracefully
* persist unfinished state
* do not repeatedly hammer Claude
* determine reset time if reliably available
* schedule/back off appropriately
* resume later

The implementation should NOT rely on an endless Claude conversation.

---

# 51. Subscription/quota awareness

Claude subscription usage is finite.

The system should make reasonable use of available capacity.

Desired behavior:

If abundant capacity exists:

Perform discovery and research normally.

If capacity becomes constrained:

Prioritize high-value opportunities.

If limits are reached:

Stop.

Do not automatically purchase API credits.

Do not automatically switch to pay-as-you-go.

Do not retry every few seconds.

If an official supported usage status mechanism exists, use it.

If no reliable programmatic usage percentage exists, graceful handling of Claude limit errors and reset information is acceptable.

Avoid unsupported scraping of Claude's UI merely to determine quota.

---

# 52. Model selection

The architecture should allow different Claude models to be used for different tasks when supported.

For example:

Lower-cost/faster model:

* discovery
* pre-screening
* simple extraction

More capable reasoning model:

* deep analysis
* skeptical verification
* complex opportunity reasoning

The exact model selection should remain configurable.

Do not hard-code a model name throughout business logic.

---

# 53. Context efficiency

Each agent invocation should receive the minimum context necessary.

Avoid sending:

* all previously researched companies
* full database dumps
* unrelated research
* huge conversation histories

The database should provide structured context.

One company's deep analysis should normally be isolated from unrelated companies.

This reduces context consumption and cross-company contamination.

---

# 54. Structured outputs

Agent outputs must be structured and validated.

Prefer JSON Schema, typed structured output, or equivalent.

Do not depend on parsing arbitrary Markdown to obtain core business data.

Human-readable summaries may be generated in addition to structured data.

All important agent outputs should be validated before being persisted.

Invalid output should trigger controlled retry or failure behavior rather than corrupt database state.

---

# 55. Core data entities

At minimum the domain model should represent:

### Company

Identity and basic business information.

### Discovery Campaign

How/why companies are being searched.

### Research Run

An execution of company investigation.

### Source

A public source used during research.

### Evidence Item

A claim supported by a source.

### Opportunity

A potential business problem/solution.

### Opportunity Evaluation

Scoring and verification.

### Offer

Commercial proposal.

### Contact

Potential decision-maker.

### Outreach Draft

Generated email.

### Outreach Outcome

Manual sales result.

### Work Item / Agent Job

Autonomous processing queue.

### System Configuration

Operator-controlled settings.

The implementation planner may adjust entity boundaries, but must preserve the information requirements.

---

# 56. Suggested company fields

A Company should conceptually be capable of storing:

* ID
* name
* normalized domain
* website
* country
* region
* industry
* business type
* company size estimate
* company size confidence
* language
* description
* first discovered date
* last discovered date
* last researched date
* next eligible research date
* source campaign
* current lifecycle status
* exclusion reason
* notes

---

# 57. Suggested evidence fields

Evidence should conceptually include:

* ID
* company ID
* opportunity ID where relevant
* source ID
* claim
* classification
* supporting text/summary
* source URL
* source title
* retrieved timestamp
* confidence
* agent that generated it
* validity/freshness state

Classification:

FACT

INFERENCE

HYPOTHESIS

UNKNOWN

---

# 58. Suggested opportunity fields

An opportunity should conceptually support:

* ID
* company ID
* problem title
* problem description
* problem category
* facts
* inferences
* hypotheses
* unknowns
* economic impact
* impact assumptions
* affected business role
* proposed solution
* implementation strategy
* dependencies
* risks
* estimated implementation duration
* suggested price
* recurring revenue possibility
* demo concept
* individual scoring dimensions
* raw score
* penalties
* adjusted score
* confidence
* verifier result
* status
* created date
* last updated date
* operator feedback

---

# 59. Duplicate opportunity prevention

The same company may have multiple legitimate opportunities.

However, the system must recognize when it is repeatedly rediscovering essentially the same problem.

Example:

“Automate incoming customer email.”

and

“AI customer enquiry triage.”

may represent the same underlying opportunity.

Store rejected opportunities rather than deleting them.

Future analysis should be able to determine:

> We already investigated this idea for this company and rejected it.

---

# 60. Re-research behavior

A rejected company or opportunity should not necessarily be blocked forever.

It may become relevant again if:

* enough time has passed
* website changes
* company grows
* new vacancies appear
* new processes become visible
* previous software disappears
* major company event occurs
* operator manually requests reconsideration

Re-research windows should eventually be configurable.

---

# 61. Company blacklist and exclusion system

The operator needs persistent controls such as:

* exclude company permanently
* exclude domain
* exclude industry
* exclude country
* pause campaign
* ignore company temporarily

The system must respect these exclusions during future autonomous discovery.

---

# 62. Research resource etiquette

The system should act responsibly when researching sites.

Requirements include:

* reasonable request rates
* no intentional denial-of-service behavior
* no bypassing authentication
* no defeating CAPTCHAs for unauthorized access
* no accessing private data
* no circumventing paywalls
* respect applicable site restrictions and terms where relevant
* use public information
* avoid unnecessarily fetching the same pages repeatedly

The objective is research, not aggressive scraping.

---

# 63. Contact and privacy principles

Only gather contact information useful for legitimate B2B outreach.

Avoid building unnecessary personal dossiers.

Prefer professional/public business information.

Store only information needed for:

* determining relevant decision-maker
* contacting that person professionally
* maintaining outreach history

Provide a way to delete contact/company records if necessary.

---

# 64. Cold outreach compliance

The operator is responsible for manually sending outreach.

Nevertheless, the system should support responsible outreach.

It should:

* avoid mass automated sending
* avoid deceptive identity
* avoid false claims
* maintain contact history
* allow “do not contact” status
* avoid generating repeated outreach for people marked as opted out
* support respecting applicable local marketing/privacy laws

Automatic legal conclusions about whether a specific contact can be emailed should not be treated as authoritative.

---

# 65. Do-not-contact state

A contact/company should support permanent:

**DO_NOT_CONTACT**

status.

Once set, autonomous processes must not generate new outreach for that contact unless the operator explicitly reverses the status.

---

# 66. Failure handling

Autonomous processing must assume failures happen.

Possible failures:

* Claude usage limit
* malformed Claude output
* website unavailable
* DNS error
* rate limiting
* page changed
* source inaccessible
* network lost
* laptop sleeps
* app crashes
* database locked
* agent timeout

Each task must fail independently.

One failed company must not crash the entire research loop.

Failures should be logged and categorized as:

retryable

or

non-retryable.

---

# 67. Crash recovery

After restart, the system should recover persistent work state.

A task left RUNNING because the process died should eventually become recoverable.

Avoid leaving companies permanently locked because a previous agent session was interrupted.

---

# 68. Observability

Provide enough logging to understand autonomous behavior.

Useful information includes:

* task started
* task completed
* task failed
* Claude limit reached
* company discovered
* duplicate ignored
* company promoted to research
* opportunity generated
* opportunity rejected by verifier
* outreach draft generated

Logs should be understandable by the operator.

Avoid logging secrets.

---

# 69. Run history

The dashboard should expose recent autonomous activity.

Example:

14:31 — discovered ABC Recruitment

14:33 — ABC passed pre-screen, 76/100

14:41 — deep research completed

14:43 — candidate intake opportunity generated

14:47 — verifier KEEP, adjusted score 87

14:50 — decision-maker found

14:52 — email drafted

This provides trust and makes autonomous operation understandable.

---

# 70. Configuration UI

Eventually provide configuration for:

* autonomous mode on/off
* countries
* industries
* company-size range
* excluded sectors
* score threshold
* Claude models
* discovery volume
* research depth
* minimum confidence
* pricing bands
* re-research interval
* campaign priorities
* maximum simultaneous work
* possibly daily research limits

MVP may initially use a config file if necessary, but architecture should anticipate operator configuration.

---

# 71. Pause / resume

The operator must always be able to:

**PAUSE AUTONOMOUS RESEARCH**

and

**RESUME AUTONOMOUS RESEARCH**

without losing state.

---

# 72. Manual research

Although automation is central, the operator should eventually be able to enter a company/domain manually and request:

**Research this company now.**

That company should proceed through the same research, analysis, verification, offer, contact, and outreach pipeline.

---

# 73. Opportunity search/filtering

Dashboard should eventually support filtering by:

* score
* company
* industry
* country
* opportunity category
* status
* verifier result
* sent/not sent
* reply status
* date
* campaign

Search should allow company/domain lookup.

---

# 74. Outcome analytics

Once enough outreach exists, show simple metrics such as:

* reply rate
* positive reply rate
* meeting rate
* win rate
* average opportunity score
* score versus response
* performance by industry
* performance by country
* performance by problem category
* performance by campaign
* performance by price band

Avoid misleading metrics when sample sizes are tiny.

---

# 75. Autonomous strategy improvement

Later, Claude may periodically review historical data.

Example task:

> Analyze the last 100 researched businesses and 30 outreach attempts. Which industries, opportunity categories and company characteristics appear most promising? Recommend how future discovery capacity should be allocated.

The system may propose strategy changes.

Initially, the operator must approve meaningful strategy changes.

Do not let the agent completely redefine targeting based on three emails.

---

# 76. Future opportunity: recurring patterns

An important long-term purpose is identifying repeated problems.

Example:

After 200 companies:

17 recruitment agencies exhibit similar candidate intake friction.

If the same problem repeatedly appears and companies respond positively, surface:

**Potential Productized Service**

or

**Potential SaaS Opportunity**

with supporting statistics.

This may eventually guide what the operator should build as a scalable business.

---

# 77. Security

Local credentials must be handled securely.

Never commit:

* Claude OAuth credentials
* authentication tokens
* API keys
* email credentials
* private configuration secrets

to Git.

Use environment variables or appropriate secure local storage.

Ensure logs do not expose secrets.

---

# 78. Billing safety

This requirement is critical.

The application must not accidentally generate unexpected Anthropic API charges.

If subscription-backed Claude capacity is exhausted:

**STOP.**

Do not automatically:

* use `ANTHROPIC_API_KEY`
* enable API credits
* switch provider billing
* purchase credits

Any future paid usage mode must require explicit operator configuration.

---

# 79. Data export

The operator should eventually be able to export useful information such as:

* companies
* opportunities
* contacts
* outreach
* outcomes

CSV and/or JSON is sufficient.

The system must not lock valuable research entirely inside the UI.

---

# 80. Backup

Because accumulated research and sales outcomes become valuable, provide a simple database backup mechanism.

For local SQLite this can initially be extremely simple.

The implementation plan should include safe backup/restore.

---

# 81. Versioning / prompt management

Agent prompts are effectively business logic.

Do not scatter massive prompt strings throughout random application files.

Prompts should be organized, identifiable, and preferably versioned.

Research records should eventually be able to identify which prompt/version produced them.

This makes it possible to compare improvements over time.

---

# 82. Agent reproducibility and auditability

Where practical, persist:

* task type
* model
* prompt version
* timestamp
* company
* structured output
* final status
* relevant errors

The operator should be able to understand how an opportunity entered the system.

Exact hidden model reasoning is neither required nor desired.

Persist outputs and evidence rather than chain-of-thought.

---

# 83. Research quality over speed

Do not optimize the system to brag that:

> We researched 10,000 companies.

The preferred outcome is:

> We researched 200 companies and found 8 unusually credible opportunities.

Research should become deeper only after the prospect demonstrates promise.

---

# 84. Research quality indicators

The system should eventually measure quality indicators such as:

* number of independent supporting sources
* percentage of claims categorized FACT
* important unknowns
* source freshness
* evidence confidence
* skeptic confidence

A 90/100 opportunity supported primarily by hypotheses should be considered suspicious.

---

# 85. Human trust

The product must make it easy for the operator to answer:

**Why should I believe this opportunity?**

Therefore no important recommendation should be presented only as a black-box score.

The UI should expose:

WHY CLAUDE LIKES THIS

WHY THE SKEPTIC MIGHT REJECT IT

WHAT WE KNOW

WHAT WE INFER

WHAT WE DON'T KNOW

WHAT I SHOULD VERIFY BEFORE CONTACTING THEM

---

# 86. Example desired opportunity

Example only:

Company:

ABC Recruitment Ltd.

Country:

United Kingdom.

Company size:

Approximately 10–20 employees.

Problem:

Potentially manual candidate intake and initial qualification.

Facts:

Company advertises 18 active roles.

Applicants are instructed to send CV and details through a general recruitment submission process.

Small recruiter team is publicly visible.

Inference:

Recruiters may spend meaningful time on first-pass candidate processing.

Unknown:

Actual application volume and current internal ATS automation.

Proposed solution:

Automated candidate intake workflow that extracts structured candidate data, compares relevant information with role requirements, creates a reviewer summary, and places candidates into a structured review queue.

Important constraint:

Human recruiter remains decision-maker.

Economic hypothesis:

Several recruiter-hours per week may be spent on repetitive first-pass administration.

Suggested project:

One-to-two-day prototype/integration.

Suggested price:

€900 setup.

Optional:

€99/month support/hosting if justified.

Demo:

Process dummy CVs against several public vacancies and show resulting structured review dashboard.

Research confidence:

High enough to contact, but email should phrase workload as a question rather than claim.

Verifier:

KEEP.

Score:

87/100.

Contact:

Relevant managing director or recruitment operations owner.

Outreach:

Short, factual, specific.

---

# 87. Example desired outreach

The system should generate something similar in spirit to:

Subject:

Candidate intake at ABC

Body:

Hi Sarah,

I was looking through ABC's recruitment process and noticed you currently advertise a number of roles with candidates submitting their details through your application process.

If your recruiters are still doing much of the first-pass CV sorting manually, I think there may be a fairly simple automation opportunity there.

I could build a workflow that extracts the relevant candidate information, checks it against the role criteria and gives the recruiter a structured review rather than replacing the human decision.

I could show you a small demo with dummy CVs first.

Worth a look?

Mario

The exact copy will vary.

The important qualities are:

specific

truthful

short

human

low pressure

problem focused

not AI hype.

---

# 88. Example bad opportunity

Company has a contact form.

Agent conclusion:

> They probably process hundreds of leads manually and need an AI chatbot.

This must be rejected.

Why:

A contact form is a fact.

High volume is unsupported.

Manual processing is unsupported.

A chatbot may not solve the problem.

Economic value is unknown.

No evidence of urgency.

This is exactly the type of AI-generated pseudo-opportunity the system must avoid.

---

# 89. Example of correct reasoning

FACT:

Website sends enquiries through a general form.

FACT:

FAQ promises replies within two business days.

FACT:

Several customer reviews mention difficulty getting timely responses.

INFERENCE:

The business may experience enquiry triage or response-capacity problems.

UNKNOWN:

Actual incoming volume.

UNKNOWN:

Existing internal CRM automation.

HYPOTHESIS:

Automated classification and first-response assistance could reduce response time.

NEXT RESEARCH QUESTION:

Determine whether additional evidence supports significant enquiry volume or operational friction.

This is acceptable.

---

# 90. Core product state flow

A company's lifecycle may conceptually move through:

DISCOVERED

↓

PRESCREEN_PENDING

↓

PRESCREENED

↓

RESEARCH_PENDING

↓

RESEARCHED

↓

NO_OPPORTUNITY

or

OPPORTUNITY_IDENTIFIED

↓

VERIFICATION_PENDING

↓

VERIFIER_REJECTED

or

VERIFIED

↓

OFFER_READY

↓

CONTACT_RESEARCH

↓

OUTREACH_READY

↓

REVIEWED

↓

SENT_MANUALLY

↓

REPLIED / NO_REPLY

↓

INTERESTED / NOT_INTERESTED

↓

MEETING

↓

WON / LOST

Exact implementation statuses may differ.

The state transitions must remain explicit and recoverable.

---

# 91. MVP success test

The first meaningful product validation is NOT whether every feature works.

The primary MVP test is:

> Run the system autonomously for several days.

Then ask:

> Does it produce approximately 5–10 opportunities where the operator independently reviews the research and genuinely believes these are businesses worth contacting with specific solutions?

Success means:

The research feels credible.

The problem is specific.

Sources support the reasoning.

The solution is feasible.

The price makes sense.

The decision-maker is relevant.

The email feels worth sending.

Failure means:

Generic AI ideas.

Hallucinated business problems.

No evidence.

Same recommendation for every company.

Poor contacts.

Massive implementation requirements.

Weak economic value.

---

# 92. Secondary success test

After enough outreach:

Does the system identify opportunities that produce:

* replies
* conversations
* meetings
* eventually paid projects?

Ultimately, sales outcomes should override Claude's subjective opinion about opportunity quality.

---

# 93. Non-goals for initial versions

The initial product is NOT intended to be:

* a multi-user SaaS
* an automated email blasting platform
* a CRM replacement
* a full sales engagement suite
* a LinkedIn automation bot
* an enterprise web crawler
* an autonomous salesperson making commitments
* an automatic contract negotiator
* an automatic payment system
* a massive distributed system

Do not overengineer these areas.

---

# 94. Explicit MVP exclusions

Do not initially build:

automatic email sending.

Complex CRM integrations.

Accounts/multi-tenancy.

Subscription billing.

Public registration.

Mobile app.

Complex ML models.

Vector databases unless genuinely required.

Kafka.

Microservices.

Kubernetes.

Massive scraping infrastructure.

Automatic demo generation.

Automatic contract creation.

Automated negotiation.

These may be reconsidered only after core product validation.

---

# 95. Core MVP capabilities that must eventually work together

The first complete usable product should allow the following scenario:

The operator launches the application.

Autonomous mode is enabled.

The system finds real companies.

Duplicate businesses are ignored.

Companies receive a lightweight screening.

Promising companies receive deeper research.

The research produces evidence-backed facts/inferences/unknowns.

Claude identifies plausible problems.

Low-quality opportunities are discarded.

Promising opportunities receive transparent scores.

A separate skeptic challenges them.

Strong surviving opportunities receive a concrete offer.

The system identifies an appropriate decision-maker.

Contact information is marked with confidence/source.

Claude drafts a truthful personalized email.

The operator opens the dashboard.

The operator reviews evidence.

The operator decides whether the opportunity is good.

The operator edits/copies the email.

The operator sends it manually.

The operator records what happened.

That outcome remains available for future strategy analysis.

---

# 96. Core engineering philosophy

Prefer:

simple

observable

recoverable

testable

typed

modular

local-first

structured

over:

clever

distributed

opaque

overengineered.

Agents should perform ambiguous reasoning.

Normal deterministic application code should perform things such as:

* state transitions
* deduplication
* scheduling
* persistence
* validation
* sorting
* filtering
* retries
* configuration
* scoring calculations where deterministic
* UI behavior

Do not ask Claude to reason about things normal code can reliably enforce.

---

# 97. Separation of responsibilities

Use AI where judgment is required.

Use deterministic code where correctness is required.

For example:

Claude:

“Does this appear to represent meaningful operational friction?”

Application code:

“Has this domain already been researched within the freshness window?”

Claude:

“Who likely owns this problem?”

Application code:

“Is this email classified VERIFIED before displaying the verified badge?”

Claude:

“What price seems commercially sensible?”

Application code:

“Does the structured response satisfy the required schema?”

This distinction should guide architecture.

---

# 98. Testing expectations

The eventual implementation plan must include testing of both deterministic logic and AI workflows.

Important deterministic tests include:

* domain normalization
* deduplication
* score calculation
* state transitions
* priority selection
* failure recovery
* configuration
* database behavior

Agent-related testing should use representative scenarios such as:

* strong real opportunity
* weak generic opportunity
* insufficient evidence
* already solved problem
* duplicate company
* missing website
* misleading evidence
* regulated/high-risk solution
* guessed contact email

Create fixtures where appropriate.

---

# 99. Seed/test mode

The implementation should eventually support a way to test the pipeline without unlimited autonomous discovery.

For example:

Provide several known company URLs manually.

Run them through:

screening

research

analysis

verification

offer creation.

This is important for improving prompts before allowing continuous operation.

---

# 100. Development requirement: phase-friendly architecture

This project will be implemented across multiple independent Claude Code sessions.

Therefore the implementation plan MUST divide work into clear phases where:

* each phase has a specific objective
* each phase leaves the repository working
* each phase has acceptance criteria
* each phase has tests
* later phases build on stable interfaces
* each session can understand what has already been implemented from repository documentation

The implementation should maintain persistent project documentation such as:

current architecture.

completed phases.

next phase.

important decisions.

known limitations.

database schema.

agent contracts.

This prevents future Claude sessions from losing architectural context.

---

# 101. Request to the implementation-planning Claude

After reading this specification, do NOT immediately implement everything.

First create a detailed implementation plan.

The plan should:

1. Restate your understanding of the product.

2. Identify ambiguous technical decisions.

3. Verify the current official Anthropic-supported method for using Claude Agent SDK / Claude Code non-interactively through the operator's Claude subscription without unintended API billing.

4. Propose the smallest sensible architecture.

5. Define project/package structure.

6. Define the initial database schema.

7. Define structured agent contracts and schemas.

8. Define the state machine/work queue.

9. Define how Claude agents will be invoked.

10. Define how web research will work.

11. Define how evidence/provenance will be represented.

12. Define the scheduler and subscription-limit behavior.

13. Define testing strategy.

14. Define the Next.js dashboard architecture.

15. Divide implementation into small phases.

16. Make each phase realistic for one separate Claude Code session where possible.

17. Give each phase exact acceptance criteria.

18. Explain what should explicitly NOT be built in each early phase.

19. Identify risks that should be validated early.

20. Prioritize validating the core assumption — that Claude can identify genuinely useful evidence-backed opportunities — before spending time polishing the UI.

Do not prematurely build complex infrastructure.

The implementation plan should optimize for reaching the first real end-to-end opportunity as early as possible.

---

# 102. Guiding statement

The following should be treated as the guiding principle of the entire system:

> The purpose of AI Opportunity Hunter is not to find companies we can spam. Its purpose is to discover evidence-backed mismatches between how a real business currently operates and how it could operate better, where the operator can cheaply bridge that gap and the resulting business value makes purchasing the solution an easy decision.

Every major architectural or product decision should be evaluated against that principle.
