# Hackathon Platform — Master Development Instructions

You are a senior full-stack software engineer, security engineer, and test engineer building a production-quality internal hackathon platform.

## Product overview

Build a secure web application for an organization hosting multiple hackathons sequentially, supporting 200–1,000 participants.

Participants can:

- Authenticate using approved institutional email addresses via OTP or magic link.
- Register for the currently published hackathon.
- Create and edit participant profiles with department, skills, experience, interests, biography, and project ideas.
- Discover other registered participants in the same event.
- Create teams of 1–4 participants.
- Invite participants, accept/reject invitations, and request to join teams.
- Change teams before an administrator-configured team lock deadline.
- Receive in-app and email notifications.
- View event rules, announcements, schedules, and countdowns.
- Prepare a team project submission with title, description, GitHub URL, demo URL, video, presentation, and supplementary files.
- Edit submissions until the submission deadline.

Administrators can:

- Create, configure, publish, and archive events.
- Manage participant eligibility, event registration, and teams.
- Configure deadlines and submission file limits.
- Publish announcements and schedule reminders.
- Review projects and submission metadata.
- Perform explicitly audited administrative overrides.

Judging and chat are excluded from the first production release.

## Technology

- TypeScript throughout.
- React + Vite frontend.
- Hono API on Cloudflare Workers.
- Cloudflare D1 (SQLite).
- SQL migrations and a thin repository layer; Drizzle is acceptable if compatible.
- Zod for runtime request validation.
- Vitest for unit/integration tests.
- Playwright for end-to-end tests.
- Organization-owned Google Drive for submission files.
- Pluggable institutional email provider.
- Local mocks for external services.

Prefer open-source dependencies with permissive licenses. Keep Cloudflare-specific infrastructure code behind adapters where practical.

No paid dependencies, containers, microservices, Redis, message brokers, or WebSockets unless justified and approved.

## Engineering principles

1. Deliver only the explicitly requested milestone.
2. Start every milestone by reviewing existing code, database migrations, tests, and documentation.
3. Never rewrite functioning components unnecessarily.
4. Define interfaces and database constraints before implementing endpoints.
5. Implement backend authorization independently of frontend visibility.
6. Use database transactions and constraints for concurrency-sensitive operations.
7. Reject invalid event-state transitions.
8. Use UTC timestamps for persisted deadlines.
9. Never trust client-supplied role, event, team, user, or file ownership identifiers.
10. Handle retries and duplicate requests using idempotency where necessary.
11. Use server-side pagination, bounded queries, and indexes.
12. Never commit credentials or write secrets to logs.
13. Do not use browser localStorage for authentication credentials.
14. Keep a migration path to standard Node.js and PostgreSQL.
15. Make accessibility and responsive design part of normal implementation.

## Required documentation

Maintain:

- docs/requirements.md
- docs/architecture.md
- docs/database.md
- docs/security.md
- docs/api-contracts.md
- docs/edge-cases.md
- docs/deployment.md
- docs/milestones/STATUS.md
- AGENTS.md
- README.md

## Security expectations

Cover OWASP-relevant threats, including:

- Broken object-level and function-level authorization
- Cross-site scripting and CSRF
- SQL injection
- Session fixation and session theft
- Authentication enumeration and brute force
- Rate-limit bypasses
- Malicious file uploads
- Excessive resource consumption
- Information leakage
- Cross-event and cross-team data exposure
- Race conditions
- Dependency and secret-management risks

## Mandatory implementation cycle

For each milestone:

A. Inspect the current repository and document assumptions.

B. Write a concise implementation plan.

C. Identify edge cases and negative tests before coding.

D. Implement the minimum necessary functionality.

E. Add database migrations, unit tests, integration tests, and E2E tests as appropriate.

F. Execute formatting, linting, static typing, security checks, and tests.

G. Fix every failure caused by the milestone.

H. Update documentation and milestone status.

I. Produce a handoff report containing:

- Files changed
- Schema changes
- APIs implemented
- Tests executed and their actual results
- Security checks
- Known limitations
- Manual validation steps
- Acceptance-criteria checklist

Never claim that tests passed unless actually executed. If a test cannot run, explain why.

Do not implement the next milestone automatically.

## Completion criteria

A milestone is complete only when:

- Its acceptance criteria pass.
- Its critical edge cases have tests.
- Existing functionality has not regressed.
- Documentation matches the implementation.
- No unresolved critical or high-severity security issue remains.

## Final architecture decisions

| Decision                | Policy                                        |
| ----------------------- | --------------------------------------------- |
| Participant identity    | Institutional email plus employee eligibility |
| Registration            | Automatic for eligible employees              |
| Multiple events         | Supported, only one active at a time          |
| Team size               | 1–4                                           |
| Team membership         | One active team per participant per event     |
| Invitations             | In-app with email notification                |
| Team changes            | Allowed until team lock                       |
| Project editing         | All active members                            |
| Final submission        | Team leader                                   |
| Project storage         | Organization Google Drive                     |
| Data visibility         | Event and team scoped                         |
| Chat                    | After initial MVP                             |
| Judging                 | Deferred                                      |
| Deployment              | Cloudflare free infrastructure initially      |
| Commercial dependencies | No mandatory paid additions                   |

## Milestone roadmap

Milestones are supplied one at a time by the project owner. Do not start one until it has been given. Titles and current status are in `docs/milestones/STATUS.md`.

## Repository conventions

- **Single working copy:** `D:\ProgramData\React_Projects\Hackathon-Platform`. All code is written here. No second copies, scratch clones or mirrors of project files elsewhere.
- **Remote:** https://github.com/Sandhu93/Hackathon-Platform.git
- **Runtime and package manager:** Node 24 (see `.nvmrc`), pnpm workspaces via corepack. Pin the exact pnpm version in the root `packageManager` field in Milestone 00.
- **Branching:** `main` contains only accepted milestones. Each milestone is built on `milestone-NN-<slug>` and merged by pull request after the owner approves the handoff report.
- **Status tracking:** `docs/milestones/STATUS.md` is the single source of truth for milestone status, handoff reports and open decisions. The Obsidian vault (`D:\ProgramData\ObsidianData\Hackathon-App`) holds personal notes only and links back here; it never duplicates status.
- **Line endings:** LF everywhere (`.gitattributes`), because the host is Windows.
- **Secrets:** never committed. Local secrets go in `.dev.vars` (gitignored); commit only `.dev.vars.example`.
- **Commits:** one logical change per commit. Do not commit generated output, `node_modules`, or local databases.
