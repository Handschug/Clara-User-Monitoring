import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  ApiStatus,
  OrgsResponse,
  ActivationResponse,
  ActivationMetrics,
  OrgDetail,
  McpSqlResult,
  EmailSearchResponse,
  EmailSearchResult,
  AttioDeal,
  AttioPipelineResponse,
} from './types.js';
import { FULL_ACTIVATION_SUMMARY, FULL_ACTIVATION_SUMMARY_FOR_ORG, ORG_MEMBERS, ORG_RECENT_AGENT_EVENTS, ORG_EVENT_BREAKDOWN, ORG_EMAIL_ACCOUNTS, ORG_EMAIL_SEARCH } from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ?? 3000;

// ---------------------------------------------------------------------------
// MCP client setup
// ---------------------------------------------------------------------------

let mcpClient: Client | null = null;

// ---------------------------------------------------------------------------
// MCP token file seeding
// ---------------------------------------------------------------------------

// mcp-remote caches OAuth tokens in ~/.mcp-auth/mcp-remote-<version>/<hash>_tokens.json
// On Railway (or any remote server) we can't do the browser OAuth flow, so we
// pre-seed these files from env vars before spawning mcp-remote.
// The hash is derived from the Clara MCP server URL and is stable.
const MCP_AUTH_DIR = path.join(homedir(), '.mcp-auth', 'mcp-remote-0.1.37');
const MCP_AUTH_HASH = 'ae2ad9697b94cadb9a498630e77901f0';

function seedMcpTokenFiles(): void {
  // Support both plain JSON and Base64-encoded env vars.
  // Base64 avoids Railway's env var encoding corrupting the JSON.
  const tokensB64      = process.env.CLARA_MCP_TOKENS_B64;
  const tokensJson     = tokensB64
    ? Buffer.from(tokensB64, 'base64').toString('utf-8')
    : process.env.CLARA_MCP_TOKENS_JSON;

  if (!tokensJson) {
    console.log('[MCP] No token env vars found — OAuth will be required');
    return;
  }

  mkdirSync(MCP_AUTH_DIR, { recursive: true });
  // Write the decoded JSON directly — no further transformation needed
  writeFileSync(path.join(MCP_AUTH_DIR, `${MCP_AUTH_HASH}_tokens.json`), tokensJson.trim());

  // Debug: log first 80 chars of what was written so we can verify on Railway
  console.log('[MCP] Tokens file written, starts with:', tokensJson.trim().substring(0, 80));
}

// Seed before the first MCP connection attempt
seedMcpTokenFiles();

// ---------------------------------------------------------------------------
// MCP client setup
// ---------------------------------------------------------------------------

async function getMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

  console.log('[MCP] Spawning mcp-remote subprocess...');

  const mcpArgs: string[] = ['mcp-remote', 'https://app.clara-agent.de/api/mcp'];

  // Pass client info directly via CLI arg — bypasses file-based lookup entirely.
  // Support both plain JSON and Base64-encoded env vars.
  const clientInfoB64  = process.env.CLARA_MCP_CLIENT_INFO_B64;
  const clientInfoJson = clientInfoB64
    ? Buffer.from(clientInfoB64, 'base64').toString('utf-8')
    : process.env.CLARA_MCP_CLIENT_INFO_JSON;
  if (clientInfoJson) {
    mcpArgs.push('--static-oauth-client-info', clientInfoJson.trim());
    console.log('[MCP] Using --static-oauth-client-info, client_id present:', clientInfoJson.includes('"client_id"'));
  }

  const transport = new StdioClientTransport({
    command: 'npx',
    args: mcpArgs,
  });

  const client = new Client(
    { name: 'clara-dashboard', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  mcpClient = client;
  console.log('[MCP] Connected to clara-analysis server');
  return client;
}

/**
 * Call an MCP tool and return its result. Throws on error (no silent failures).
 */
async function callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const client = await getMcpClient();
  console.log(`[MCP] Calling tool: ${toolName}`, Object.keys(args).length ? args : '');

  const result = await client.callTool({ name: toolName, arguments: args });

  if (result.isError) {
    const msg = `MCP tool '${toolName}' returned an error: ${JSON.stringify(result.content)}`;
    console.error(`[MCP ERROR] ${msg}`);
    throw new Error(msg);
  }

  return result.content;
}

/**
 * Run a SQL query via the clara-analysis sql_query tool.
 * Returns typed rows as an array of record objects.
 */
async function sqlQuery(sql: string): Promise<Record<string, unknown>[]> {
  const content = await callTool('sql_query', { sql: sql.trim() });

  // The MCP tool returns content as an array of text/data blocks
  const blocks = content as Array<{ type: string; text?: string; data?: unknown }>;
  const textBlock = blocks.find((b) => b.type === 'text');
  if (!textBlock?.text) return [];

  const parsed: McpSqlResult = JSON.parse(textBlock.text);
  return parsed.rows ?? [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse PostgreSQL array values which may arrive as "{a,b}" strings or already as JS arrays. */
function parsePostgresArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1);
    if (inner === '') return [];
    return inner.split(',').map((s) => s.replace(/^"|"$/g, '').trim());
  }
  return [];
}

/**
 * A sync error is considered stale (and suppressed) if emails were received
 * in the last 24 hours — clear proof that the sync is still working.
 * The Clara backend does not clear last_sync_error on recovery, so without
 * this check every transient error would show forever.
 */
function isSyncErrorActive(hasSyncError: boolean, lastEmailReceived: string | null): boolean {
  if (!hasSyncError) return false;
  if (!lastEmailReceived) return true;
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return new Date(lastEmailReceived).getTime() < oneDayAgo;
}

function computeHealthStatus(
  hasEmailSync: boolean,
  agentEventsLast7Days: number,
  agentEventsLast14Days: number
): 'green' | 'yellow' | 'red' {
  // Green: has email sync + agent activity in last 7 days
  if (hasEmailSync && agentEventsLast7Days > 0) return 'green';
  // Yellow: has email sync but no recent agent activity
  if (hasEmailSync && agentEventsLast7Days === 0) return 'yellow';
  // Red: no email sync, or no activity in 14+ days
  return 'red';
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Attio REST API helper
// ---------------------------------------------------------------------------

const ATTIO_TOKEN = process.env.ATTIO_TOKEN;
const ATTIO_BASE  = 'https://api.attio.com/v2';

/**
 * Call the Attio REST API. Throws on non-OK responses.
 * Requires the ATTIO_TOKEN environment variable to be set.
 */
async function attioFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!ATTIO_TOKEN) throw new Error('ATTIO_TOKEN environment variable is not set');

  const res = await fetch(`${ATTIO_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ATTIO_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Attio API ${res.status} ${res.statusText}: ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Express routes
// ---------------------------------------------------------------------------

app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * GET /api/debug/event-types
 * Returns all distinct agent_event.event_type values with counts — used to find draft event types.
 */
app.get('/api/debug/event-types', async (_req, res) => {
  try {
    const rows = await sqlQuery(`
      SELECT event_type, COUNT(*) AS count
      FROM agent_event
      GROUP BY event_type
      ORDER BY count DESC
    `);
    res.json(rows);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

/**
 * GET /api/debug/schema
 * Returns columns for all key tables — used to verify actual DB schema.
 */
app.get('/api/debug/schema', async (_req, res) => {
  try {
    const rows = await sqlQuery(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('organization','membership','email_account','email','agent_event','email_folder')
      ORDER BY table_name, ordinal_position
    `);
    res.json(rows);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

/**
 * GET /api/status
 * Ping the MCP server and return connection health.
 */
app.get('/api/status', async (_req, res) => {
  const start = Date.now();
  try {
    await callTool('ping');
    const response: ApiStatus = {
      connected: true,
      latencyMs: Date.now() - start,
      error: null,
      checkedAt: now(),
    };
    res.json(response);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[/api/status] MCP ping failed:', error);
    const response: ApiStatus = {
      connected: false,
      latencyMs: null,
      error,
      checkedAt: now(),
    };
    res.status(503).json(response);
  }
});

/**
 * GET /api/orgs
 * All organizations with member counts from list_organizations tool.
 */
app.get('/api/orgs', async (_req, res) => {
  try {
    const content = await callTool('list_organizations');
    const blocks = content as Array<{ type: string; text?: string }>;
    const textBlock = blocks.find((b) => b.type === 'text');
    const orgs = textBlock?.text ? JSON.parse(textBlock.text) : [];

    const response: OrgsResponse = {
      orgs,
      total: orgs.length,
      updatedAt: now(),
    };
    res.json(response);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[/api/orgs]', error);
    res.status(500).json({ error });
  }
});

/**
 * GET /api/activation
 * Activation status per org — the main dashboard endpoint.
 * Optional query param: ?pilotOnly=true to exclude test-tagged orgs.
 */
app.get('/api/activation', async (req, res) => {
  const pilotOnly = req.query.pilotOnly !== 'false'; // default true

  try {
    const rows = await sqlQuery(FULL_ACTIVATION_SUMMARY);

    const activation: ActivationMetrics[] = rows
      .map((row) => {
        // PostgreSQL arrays may arrive as "{tag1,tag2}" strings over MCP — parse both forms
        const tags: string[] = parsePostgresArray(row.tags);
        const hasEmailSync = Boolean(row.has_email_sync);
        const agentEventsLast7Days = Number(row.agent_events_last_7_days ?? 0);
        const agentEventsLast14Days = Number(row.agent_events_last_14_days ?? 0);

        const totalEmails = Number(row.total_emails ?? 0);
        const draftsCreated = Number(row.drafts_created ?? 0);
        const activationScore = [
          hasEmailSync,
          totalEmails > 0,
          agentEventsLast7Days > 0,
          draftsCreated > 0,
        ].filter(Boolean).length;

        return {
          orgId: String(row.org_id),
          orgName: String(row.org_name),
          tags,
          hasEmailSync,
          emailAccountCount: Number(row.email_account_count ?? 0),
          hasSyncError: Boolean(row.has_sync_error),
          syncErrorCount: Number(row.sync_error_count ?? 0),
          totalEmails,
          lastEmailReceived: row.last_email_received ? String(row.last_email_received) : null,
          agentEventsLast7Days,
          agentEventsLast14Days,
          lastAgentEvent: row.last_agent_event ? String(row.last_agent_event) : null,
          emailsLast7Days: Number(row.emails_last_7_days ?? 0),
          draftsCreated,
          setupCompleted: Boolean(row.setup_completed),
          onboardingStatus: row.onboarding_status ? String(row.onboarding_status) : null,
          memberCount: Number(row.member_count ?? 0),
          healthStatus: computeHealthStatus(hasEmailSync, agentEventsLast7Days, agentEventsLast14Days),
          activationScore,
        };
      })
      .filter((org) => {
        if (pilotOnly) {
          // Exclude orgs tagged as 'test'
          return !org.tags.some((t) => t === 'test');
        }
        return true;
      });

    const response: ActivationResponse = { activation, updatedAt: now() };
    res.json(response);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[/api/activation]', error);
    res.status(500).json({ error });
  }
});

/**
 * GET /api/org/:id
 * Detailed view for a single org.
 */
app.get('/api/org/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [memberRows, eventRows, activationRows, breakdownRows, accountRows] = await Promise.all([
      sqlQuery(ORG_MEMBERS(id)),
      sqlQuery(ORG_RECENT_AGENT_EVENTS(id)),
      sqlQuery(FULL_ACTIVATION_SUMMARY_FOR_ORG(id)),
      sqlQuery(ORG_EVENT_BREAKDOWN(id)),
      sqlQuery(ORG_EMAIL_ACCOUNTS(id)),
    ]);

    if (activationRows.length === 0) {
      res.status(404).json({ error: `Org '${id}' not found` });
      return;
    }

    const row = activationRows[0];
    const tags: string[] = parsePostgresArray(row.tags);
    const hasEmailSync = Boolean(row.has_email_sync);
    const agentEventsLast7Days = Number(row.agent_events_last_7_days ?? 0);
    const agentEventsLast14Days = Number(row.agent_events_last_14_days ?? 0);

    const totalEmails = Number(row.total_emails ?? 0);
    const draftsCreated = Number(row.drafts_created ?? 0);
    const activationScore = [
      hasEmailSync,
      totalEmails > 0,
      agentEventsLast7Days > 0,
      draftsCreated > 0,
    ].filter(Boolean).length;

    const detail: OrgDetail = {
      orgId: String(row.org_id),
      orgName: String(row.org_name),
      tags,
      hasEmailSync,
      emailAccountCount: Number(row.email_account_count ?? 0),
      hasSyncError: Boolean(row.has_sync_error),
      syncErrorCount: Number(row.sync_error_count ?? 0),
      totalEmails,
      lastEmailReceived: row.last_email_received ? String(row.last_email_received) : null,
      agentEventsLast7Days,
      agentEventsLast14Days,
      lastAgentEvent: row.last_agent_event ? String(row.last_agent_event) : null,
      emailsLast7Days: Number(row.emails_last_7_days ?? 0),
      draftsCreated,
      setupCompleted: Boolean(row.setup_completed),
      onboardingStatus: row.onboarding_status ? String(row.onboarding_status) : null,
      memberCount: Number(row.member_count ?? 0),
      healthStatus: computeHealthStatus(hasEmailSync, agentEventsLast7Days, agentEventsLast14Days),
      activationScore,
      eventBreakdown: breakdownRows.map((b) => ({
        eventType: String(b.event_type),
        count: Number(b.count),
        countLast7Days: Number(b.count_last_7_days ?? 0),
      })),
      emailAccounts: accountRows.map((a) => ({
        id: String(a.id),
        email: String(a.email),
        provider: String(a.provider),
        isAgentEnabled: Boolean(a.is_agent_enabled),
        hasSyncError: a.last_sync_error != null,
        syncError: a.last_sync_error ? String(a.last_sync_error) : null,
      })),
      members: memberRows.map((m) => ({
        id: String(m.id),
        email: String(m.email),
        name: m.name ? String(m.name) : null,
        role: String(m.role),
      })),
      recentAgentEvents: eventRows.map((e) => ({
        id: String(e.id),
        type: String(e.type),
        createdAt: String(e.created_at),
        metadata: (e.metadata as Record<string, unknown>) ?? {},
      })),
    };

    res.json(detail);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[/api/org/${id}]`, error);
    res.status(500).json({ error });
  }
});

/**
 * GET /api/org/:id/emails?q=<query>
 * Keyword search over email subjects and senders for a single org.
 * Uses ILIKE SQL search (search_emails MCP tool uses vector search but has no embeddings yet).
 * Scoped to the org via email_account → membership join.
 * Returns up to 20 matching emails with subject, sender, and date.
 */
app.get('/api/org/:id/emails', async (req, res) => {
  const { id } = req.params;
  const query = String(req.query.q ?? '').trim();

  if (!query) {
    const empty: EmailSearchResponse = { emails: [], query: '' };
    res.json(empty);
    return;
  }

  try {
    // Sanitise user input before interpolating into SQL: escape single quotes
    const safeQuery = query.replace(/'/g, "''");

    const rows = await sqlQuery(ORG_EMAIL_SEARCH(id, safeQuery));

    const emails: EmailSearchResult[] = rows.map((e) => {
      const fromName = e.from_name ? String(e.from_name) : '';
      const fromAddress = e.from_address ? String(e.from_address) : '';
      const from = fromName && fromAddress
        ? `${fromName} <${fromAddress}>`
        : fromAddress || fromName;

      return {
        id: String(e.id ?? ''),
        subject: String(e.subject ?? '(no subject)'),
        from,
        receivedAt: e.received_at ? String(e.received_at) : null,
        snippet: '',
      };
    });

    const response: EmailSearchResponse = { emails, query };
    res.json(response);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[/api/org/${id}/emails]`, error);
    res.status(500).json({ error });
  }
});

/**
 * GET /api/attio/pipeline
 * Returns all deals from Attio CRM with stage, next meeting, and company record ID.
 * Used by the frontend to show deal stage badges on org cards and enable note creation.
 */
app.get('/api/attio/pipeline', async (_req, res) => {
  try {
    const raw = await attioFetch('/objects/deals/records/query', {
      method: 'POST',
      body: JSON.stringify({ limit: 100 }),
    }) as { data: Array<{
      id: { record_id: string };
      values: Record<string, unknown[]>;
    }> };

    const deals: AttioDeal[] = raw.data.map((record) => {
      // Each attribute value is an array; take the first element.
      const nameEntry  = record.values.name?.[0]  as { value?: string }  | undefined;
      const stageEntry = record.values.stage?.[0] as { status?: { title?: string } } | undefined;
      const meetingEntry = record.values.next_meeting_8?.[0] as { value?: string } | undefined;
      const companyEntry = record.values.associated_company?.[0] as { target_record_id?: string } | undefined;

      return {
        recordId:        record.id.record_id,
        name:            nameEntry?.value ?? '',
        stage:           stageEntry?.status?.title ?? '',
        nextMeeting:     meetingEntry?.value ?? null,
        companyRecordId: companyEntry?.target_record_id ?? null,
      };
    });

    const response: AttioPipelineResponse = { deals };
    res.json(response);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[/api/attio/pipeline]', error);
    res.status(500).json({ error });
  }
});


// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[Clara Dashboard] Listening on http://localhost:${PORT}`);
  console.log('[Clara Dashboard] MCP will connect on first API request (OAuth browser flow on first run)');
});
