// Shared TypeScript types for the Clara Activation Dashboard

export interface Organization {
  id: string;
  name: string;
  tags: string[];
  memberCount: number;
  accountId?: string;
}

export interface ActivationMetrics {
  orgId: string;
  orgName: string;
  tags: string[];
  // Email sync
  hasEmailSync: boolean;
  emailAccountCount: number;
  hasSyncError: boolean;
  syncErrorCount: number;
  // Email volume
  totalEmails: number;
  lastEmailReceived: string | null; // ISO timestamp
  // Agent activity
  agentEventsLast7Days: number;
  agentEventsLast14Days: number;
  lastAgentEvent: string | null; // ISO timestamp of most recent agent event
  // Email activity
  emailsLast7Days: number;
  // Draft creation
  draftsCreated: number;
  // Activation score: 0–4 based on: email sync, emails synced, agent active, drafts created
  activationScore: number;
  // Setup completion
  setupCompleted: boolean;
  onboardingStatus: string | null;
  // Member count
  memberCount: number;
  // Computed
  healthStatus: 'green' | 'yellow' | 'red';
}

export interface EventBreakdown {
  eventType: string;
  count: number;
  countLast7Days: number;
}

export interface EmailAccount {
  id: string;
  email: string;
  provider: string;
  isAgentEnabled: boolean;
  hasSyncError: boolean;
  syncError: string | null;
}

export interface OrgDetail extends ActivationMetrics {
  members: Member[];
  recentAgentEvents: AgentEvent[];
  eventBreakdown: EventBreakdown[];
  emailAccounts: EmailAccount[];
}

export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface AgentEvent {
  id: string;
  type: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ApiStatus {
  connected: boolean;
  latencyMs: number | null;
  error: string | null;
  checkedAt: string;
}

export interface OrgsResponse {
  orgs: Organization[];
  total: number;
  updatedAt: string;
}

export interface ActivationResponse {
  activation: ActivationMetrics[];
  updatedAt: string;
}

// Email search results from the search_emails MCP tool
export interface EmailSearchResult {
  id: string;
  subject: string;
  from: string;
  receivedAt: string | null;
  snippet: string;
}

export interface EmailSearchResponse {
  emails: EmailSearchResult[];
  query: string;
}

// MCP tool call result wrappers
export interface McpSqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

// Attio CRM integration
export interface AttioDeal {
  recordId: string;
  name: string;
  stage: string;
  nextMeeting: string | null;    // ISO date "YYYY-MM-DD"
  companyRecordId: string | null; // Attio company record ID for note creation
}

export interface AttioPipelineResponse {
  deals: AttioDeal[];
}
