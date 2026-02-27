/**
 * SQL queries for the Clara Activation Dashboard.
 * All queries are read-only against the production DB via the clara-analysis MCP tool.
 *
 * Verified schema (from information_schema):
 *   organization    — id, name, internal_tags (ARRAY), status, created_at
 *   membership      — id, organization_id, user_id (text), invited_email, role
 *   email_account   — id, user_id (text), email, is_agent_enabled, provider, created_at
 *   email           — id, email_account_id, is_draft, received_at, created_at
 *   agent_event     — id, email_account_id, event_type, event_data, occurred_at
 *   email_folder    — id, email_account_id, display_name, special_use
 *
 * Join paths:
 *   org → membership: membership.organization_id = organization.id
 *   membership → email_account: email_account.user_id = membership.user_id
 *   email_account → email: email.email_account_id = email_account.id
 *   email_account → agent_event: agent_event.email_account_id = email_account.id
 */

/**
 * Full activation summary — the main query for the dashboard cards.
 * Joins org → membership → email_account → email for all per-org metrics.
 * Agent events go through email_account (no direct org_id on agent_event).
 */
export const FULL_ACTIVATION_SUMMARY = `
  SELECT
    o.id AS org_id,
    o.name AS org_name,
    o.status AS onboarding_status,
    o.internal_tags AS tags,
    CASE WHEN o.status != 'onboarding' THEN true ELSE false END AS setup_completed,

    -- Email sync: does the org have any connected email accounts?
    COUNT(DISTINCT ea.id) AS email_account_count,
    CASE WHEN COUNT(DISTINCT ea.id) > 0 THEN true ELSE false END AS has_email_sync,

    -- Sync errors: only active if last_sync_error_at is more recent than last_sync_success_at.
    -- If both timestamps are NULL (legacy rows), the error is treated as resolved.
    BOOL_OR(ea.last_sync_error IS NOT NULL AND ea.last_sync_error_at IS NOT NULL AND (ea.last_sync_success_at IS NULL OR ea.last_sync_error_at > ea.last_sync_success_at)) AS has_sync_error,
    COUNT(DISTINCT CASE WHEN ea.last_sync_error IS NOT NULL AND ea.last_sync_error_at IS NOT NULL AND (ea.last_sync_success_at IS NULL OR ea.last_sync_error_at > ea.last_sync_success_at) THEN ea.id END) AS sync_error_count,

    -- Email volume: total emails ingested and last received timestamp
    COUNT(DISTINCT e.id) AS total_emails,
    MAX(e.received_at) AS last_email_received,

    -- Drafts: agent_events of type 'draft_created' = Clara generated a reply draft
    COALESCE((
      SELECT COUNT(*)
      FROM agent_event ae
      JOIN email_account ea2 ON ea2.id = ae.email_account_id
      JOIN membership m2 ON m2.user_id = ea2.user_id
      WHERE m2.organization_id = o.id
        AND ae.event_type = 'draft_created'
    ), 0) AS drafts_created,

    -- Member count: users in the org
    COUNT(DISTINCT m.id) AS member_count,

    -- Agent activity in last 7 days (via email_account join)
    COALESCE((
      SELECT COUNT(*)
      FROM agent_event ae
      JOIN email_account ea2 ON ea2.id = ae.email_account_id
      JOIN membership m2 ON m2.user_id = ea2.user_id
      WHERE m2.organization_id = o.id
        AND ae.occurred_at >= NOW() - INTERVAL '7 days'
    ), 0) AS agent_events_last_7_days,

    -- Agent activity in last 14 days
    COALESCE((
      SELECT COUNT(*)
      FROM agent_event ae
      JOIN email_account ea2 ON ea2.id = ae.email_account_id
      JOIN membership m2 ON m2.user_id = ea2.user_id
      WHERE m2.organization_id = o.id
        AND ae.occurred_at >= NOW() - INTERVAL '14 days'
    ), 0) AS agent_events_last_14_days,

    -- Timestamp of the most recent agent event (to show "last active X days ago")
    (
      SELECT MAX(ae.occurred_at)
      FROM agent_event ae
      JOIN email_account ea2 ON ea2.id = ae.email_account_id
      JOIN membership m2 ON m2.user_id = ea2.user_id
      WHERE m2.organization_id = o.id
    ) AS last_agent_event,

    -- Emails received in last 7 days (non-draft, to measure inbox activity)
    COUNT(DISTINCT CASE WHEN e.received_at >= NOW() - INTERVAL '7 days' AND e.is_draft = false THEN e.id END) AS emails_last_7_days

  FROM organization o
  LEFT JOIN membership m ON m.organization_id = o.id
  LEFT JOIN email_account ea ON ea.user_id = m.user_id
  LEFT JOIN email e ON e.email_account_id = ea.id
  GROUP BY o.id, o.name, o.status, o.internal_tags
  ORDER BY o.name
`;

/**
 * Same as FULL_ACTIVATION_SUMMARY but scoped to a single org by ID.
 * Used by the /api/org/:id detail endpoint.
 */
export const FULL_ACTIVATION_SUMMARY_FOR_ORG = (orgId: string) => `
  SELECT
    o.id AS org_id,
    o.name AS org_name,
    o.status AS onboarding_status,
    o.internal_tags AS tags,
    CASE WHEN o.status != 'onboarding' THEN true ELSE false END AS setup_completed,
    COUNT(DISTINCT ea.id) AS email_account_count,
    CASE WHEN COUNT(DISTINCT ea.id) > 0 THEN true ELSE false END AS has_email_sync,
    BOOL_OR(ea.last_sync_error IS NOT NULL AND ea.last_sync_error_at IS NOT NULL AND (ea.last_sync_success_at IS NULL OR ea.last_sync_error_at > ea.last_sync_success_at)) AS has_sync_error,
    COUNT(DISTINCT CASE WHEN ea.last_sync_error IS NOT NULL AND ea.last_sync_error_at IS NOT NULL AND (ea.last_sync_success_at IS NULL OR ea.last_sync_error_at > ea.last_sync_success_at) THEN ea.id END) AS sync_error_count,
    COUNT(DISTINCT e.id) AS total_emails,
    MAX(e.received_at) AS last_email_received,
    COALESCE((
      SELECT COUNT(*)
      FROM agent_event ae
      JOIN email_account ea2 ON ea2.id = ae.email_account_id
      JOIN membership m2 ON m2.user_id = ea2.user_id
      WHERE m2.organization_id = o.id
        AND ae.event_type = 'draft_created'
    ), 0) AS drafts_created,
    COUNT(DISTINCT m.id) AS member_count,
    COALESCE((
      SELECT COUNT(*)
      FROM agent_event ae
      JOIN email_account ea2 ON ea2.id = ae.email_account_id
      JOIN membership m2 ON m2.user_id = ea2.user_id
      WHERE m2.organization_id = o.id
        AND ae.occurred_at >= NOW() - INTERVAL '7 days'
    ), 0) AS agent_events_last_7_days,
    COALESCE((
      SELECT COUNT(*)
      FROM agent_event ae
      JOIN email_account ea2 ON ea2.id = ae.email_account_id
      JOIN membership m2 ON m2.user_id = ea2.user_id
      WHERE m2.organization_id = o.id
        AND ae.occurred_at >= NOW() - INTERVAL '14 days'
    ), 0) AS agent_events_last_14_days,
    (
      SELECT MAX(ae.occurred_at)
      FROM agent_event ae
      JOIN email_account ea2 ON ea2.id = ae.email_account_id
      JOIN membership m2 ON m2.user_id = ea2.user_id
      WHERE m2.organization_id = o.id
    ) AS last_agent_event,
    COUNT(DISTINCT CASE WHEN e.received_at >= NOW() - INTERVAL '7 days' AND e.is_draft = false THEN e.id END) AS emails_last_7_days
  FROM organization o
  LEFT JOIN membership m ON m.organization_id = o.id
  LEFT JOIN email_account ea ON ea.user_id = m.user_id
  LEFT JOIN email e ON e.email_account_id = ea.id
  WHERE o.id = '${orgId}'
  GROUP BY o.id, o.name, o.status, o.internal_tags
`;

/**
 * Detailed org view: member list.
 * No separate user table — get email from email_account, fall back to invited_email.
 */
export const ORG_MEMBERS = (orgId: string) => `
  SELECT
    m.id,
    COALESCE(ea.email, m.invited_email) AS email,
    m.user_id AS name,
    m.role
  FROM membership m
  LEFT JOIN email_account ea ON ea.user_id = m.user_id
  WHERE m.organization_id = '${orgId}'
  ORDER BY m.role, ea.email
`;

/**
 * Agent event counts broken down by event_type for a single org.
 * Shows what Clara is actually doing: classifying, tagging, moving, drafting.
 */
export const ORG_EVENT_BREAKDOWN = (orgId: string) => `
  SELECT
    ae.event_type,
    COUNT(*) AS count,
    COUNT(CASE WHEN ae.occurred_at >= NOW() - INTERVAL '7 days' THEN 1 END) AS count_last_7_days
  FROM agent_event ae
  JOIN email_account ea ON ea.id = ae.email_account_id
  JOIN membership m ON m.user_id = ea.user_id
  WHERE m.organization_id = '${orgId}'
  GROUP BY ae.event_type
  ORDER BY count DESC
`;

/**
 * Email accounts for a single org with their sync status and error state.
 */
export const ORG_EMAIL_ACCOUNTS = (orgId: string) => `
  SELECT
    ea.id,
    ea.email,
    ea.provider,
    ea.is_agent_enabled,
    ea.last_sync_error,
    ea.last_sync_error_at,
    ea.last_sync_success_at,
    ea.sync_started_at,
    ea.created_at
  FROM email_account ea
  JOIN membership m ON m.user_id = ea.user_id
  WHERE m.organization_id = '${orgId}'
  ORDER BY ea.created_at
`;

/**
 * Keyword search over email subjects and sender fields for a single org.
 * Uses ILIKE for case-insensitive matching on subject, from_address, from_name.
 * Real column names discovered from the search_emails error trace:
 *   email.subject, email.from_address, email.from_name, email.received_at
 * Scoped to org via email_account → membership join.
 */
export const ORG_EMAIL_SEARCH = (orgId: string, query: string) => `
  SELECT
    e.id,
    e.subject,
    e.from_address,
    e.from_name,
    e.received_at
  FROM email e
  JOIN email_account ea ON ea.id = e.email_account_id
  JOIN membership m ON m.user_id = ea.user_id
  WHERE m.organization_id = '${orgId}'
    AND e.is_draft = false
    AND (
      e.subject      ILIKE '%${query}%'
      OR e.from_address ILIKE '%${query}%'
      OR e.from_name    ILIKE '%${query}%'
    )
  ORDER BY e.received_at DESC
  LIMIT 20
`;

/**
 * Per-member activation stats for a single org.
 * One row per membership: counts their emails, agent events, and drafts.
 * Used in the org detail modal to show individual user activity alongside org totals.
 */
export const ORG_MEMBER_STATS = (orgId: string) => `
  SELECT
    m.id AS member_id,
    m.user_id,
    m.role,
    COALESCE(MIN(ea.email), m.invited_email) AS email,

    -- How many email accounts this user has connected
    COUNT(DISTINCT ea.id) AS email_account_count,

    -- Email volume for this user
    COUNT(DISTINCT e.id) AS total_emails,
    COUNT(DISTINCT CASE WHEN e.received_at >= NOW() - INTERVAL '7 days' AND e.is_draft = false THEN e.id END) AS emails_last_7_days,

    -- Agent activity for this user
    COUNT(DISTINCT ae.id) AS total_agent_events,
    COUNT(DISTINCT CASE WHEN ae.occurred_at >= NOW() - INTERVAL '7 days' THEN ae.id END) AS agent_events_last_7_days,

    -- Drafts Clara created for this user
    COUNT(DISTINCT CASE WHEN ae.event_type = 'draft_created' THEN ae.id END) AS drafts_created,

    -- When Clara last ran for this user
    MAX(ae.occurred_at) AS last_agent_event

  FROM membership m
  LEFT JOIN email_account ea ON ea.user_id = m.user_id
  LEFT JOIN email e ON e.email_account_id = ea.id
  LEFT JOIN agent_event ae ON ae.email_account_id = ea.id
  WHERE m.organization_id = '${orgId}'
  GROUP BY m.id, m.user_id, m.role, m.invited_email
  ORDER BY total_agent_events DESC, email
`;

/**
 * Recent agent events for a single org (last 30 days, most recent first).
 * Joins through email_account → membership to scope by org.
 */
export const ORG_RECENT_AGENT_EVENTS = (orgId: string) => `
  SELECT
    ae.id,
    ae.event_type AS type,
    ae.occurred_at AS created_at,
    ae.event_data AS metadata
  FROM agent_event ae
  JOIN email_account ea ON ea.id = ae.email_account_id
  JOIN membership m ON m.user_id = ea.user_id
  WHERE m.organization_id = '${orgId}'
    AND ae.occurred_at >= NOW() - INTERVAL '30 days'
  ORDER BY ae.occurred_at DESC
  LIMIT 50
`;
