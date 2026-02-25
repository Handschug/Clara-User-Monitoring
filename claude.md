# Project: Clara Activation Dashboard

## What this is
A local web dashboard that connects to the Clara MCP server and visualizes 
pilot customer activation health. Built for internal use by the Clara ops team.

## Tech stack
- Runtime: Node 20+
- Package manager: npm
- Frontend: plain HTML + vanilla JS (no framework — keep it simple)
- Backend: Express.js server that queries MCP tools and serves data
- No database — all data fetched live from Clara MCP

## MCP Server
- Server name: clara-analysis
- Tools available:
  - `ping` — connection test
  - `list_organizations` — all orgs with tags, members, account IDs
  - `sql_query` — read-only SQL against production DB
  - `search_emails` — semantic search over email content
- The MCP server is already configured in ~/.claude.json
- Always call list_organizations first to understand available data before 
  writing SQL queries

## Project structure
src/
  server.ts         — Express server, MCP tool calls, REST endpoints
  queries.ts        — all SQL queries in one place, named and documented
  types.ts          — shared TypeScript types
public/
  index.html        — dashboard UI
  dashboard.js      — frontend logic, fetches from Express endpoints
  styles.css        — styling
CLAUDE.md

## Commands
- `npm run dev`   — start dev server with hot reload
- `npm run build` — compile TypeScript
- `npm start`     — run compiled version

## API endpoints (to build)
- GET /api/status          — ping MCP, return connection health
- GET /api/orgs            — all organizations with member counts
- GET /api/activation      — activation status per org (see metrics below)
- GET /api/org/:id         — detailed view for a single org

## Activation metrics to track
For each pilot org, the dashboard should show:

- Email sync status — does the org have at least one email_account connected?
- Email volume — how many emails have been synced total?
- Last email received — timestamp of most recent email
- Agent activity — count of agent_events in last 7 days
- Draft creation — how many drafts has Clara created?
- Setup completion — has the org moved past onboarding status?
- Member count — how many users are in the org?

## Dashboard UI requirements
- Single page, no routing
- One card per organization
- Color-coded health status: green (active), yellow (partial), red (stuck)
- Show last updated timestamp
- Auto-refresh every 60 seconds
- Filter toggle: show all orgs vs pilot orgs only (exclude internal_tags: test)
- Keep it functional over pretty — this is an internal ops tool

## Health status logic
- Green: has email sync + agent_events in last 7 days
- Yellow: has email sync but no recent agent activity
- Red: no email sync or no activity in 14+ days

## Conventions
- TypeScript strict mode
- All SQL queries go in queries.ts — never inline in server.ts
- Named exports only
- No silent failures — log all MCP errors explicitly
- Comments on SQL queries explaining what they're measuring and why

## Context for Claude
This dashboard is used by Elias (COO) at Clara, an AI email automation 
platform for German tax advisors. The immediate use case is monitoring 
pilot customer activation — specifically whether customers have completed 
setup and are getting daily value from Clara.

Key pilot customers to watch:
- Martina (ADVIGO) — has email sync, hasn't completed setup
- Silke (Dockter & Partner) — has email sync, hasn't completed setup

Onboarding calls scheduled: Martina Feb 20, Silke Feb 25.

Exclude any orgs tagged with internal_tags containing 'test' from the 
default view — these are internal Clara accounts used for testing.

The schema is documented in the sql_query tool description. Key tables:
organization, membership, email_account, email, agent_event, email_folder.
Join path for email → org goes through email_account → membership.