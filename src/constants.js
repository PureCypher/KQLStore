// ============================================================
// Constants
// ============================================================
const CATEGORIES = ['Detection', 'Hunting', 'Investigation', 'Monitoring', 'Reporting', 'Enrichment', 'Utility'];

const CATEGORY_COLORS = {
  'Detection':     { bg: 'rgba(255, 68, 68, 0.08)',   text: '#ff6b6b',  border: 'rgba(255, 68, 68, 0.2)' },
  'Hunting':       { bg: 'rgba(0, 255, 136, 0.08)',    text: '#00ff88',  border: 'rgba(0, 255, 136, 0.2)' },
  'Investigation': { bg: 'rgba(255, 180, 0, 0.08)',    text: '#ffb400',  border: 'rgba(255, 180, 0, 0.2)' },
  'Monitoring':    { bg: 'rgba(0, 212, 255, 0.08)',    text: '#00d4ff',  border: 'rgba(0, 212, 255, 0.2)' },
  'Reporting':     { bg: 'rgba(168, 130, 255, 0.08)',  text: '#a882ff',  border: 'rgba(168, 130, 255, 0.2)' },
  'Enrichment':    { bg: 'rgba(229, 192, 123, 0.08)',  text: '#e5c07b',  border: 'rgba(229, 192, 123, 0.2)' },
  'Utility':       { bg: 'rgba(107, 114, 128, 0.08)',  text: '#8b8fa3',  border: 'rgba(107, 114, 128, 0.2)' },
};

const CATEGORY_MIGRATION = {
  'Threat Hunting':    'Hunting',
  'Incident Response': 'Investigation',
  'Identity & Access': 'Detection',
  'Network':           'Detection',
  'Compliance':        'Reporting',
  'Custom':            'Utility',
};

const SENTINEL_TABLES = [
  'SigninLogs','AuditLogs','SecurityEvent','SecurityAlert','SecurityIncident',
  'Syslog','CommonSecurityLog','ThreatIntelligenceIndicator','OfficeActivity',
  'AzureActivity','AzureDiagnostics','Heartbeat','Usage','DnsEvents',
  'W3CIISLog','WindowsFirewall','WindowsEvent',
];

const DEFENDER_TABLES = [
  'DeviceProcessEvents','DeviceNetworkEvents','DeviceFileEvents','DeviceLogonEvents',
  'DeviceRegistryEvents','DeviceImageLoadEvents','DeviceEvents','DeviceInfo',
  'DeviceTvmSoftwareVulnerabilities','EmailEvents','EmailAttachmentInfo','EmailUrlInfo',
  'EmailPostDeliveryEvents','IdentityLogonEvents','IdentityQueryEvents',
  'IdentityDirectoryEvents','CloudAppEvents','AADSignInEventsBeta','AlertInfo',
  'AlertEvidence','BehaviorEntities','BehaviorInfo','UrlClickEvents',
];

const ALL_KNOWN_TABLES = [...SENTINEL_TABLES, ...DEFENDER_TABLES];

const TABLE_STYLES = {
  sentinel: { bg: 'rgba(229, 192, 123, 0.1)', text: '#e5c07b', border: 'rgba(229, 192, 123, 0.25)' },
  defender: { bg: 'rgba(97, 175, 239, 0.1)', text: '#61afef', border: 'rgba(97, 175, 239, 0.25)' },
  // ASIM parsers are normalised schemas rather than raw tables, and Microsoft steers new
  // detection content towards them, so they get their own group and badge.
  asim:     { bg: 'rgba(198, 120, 221, 0.1)', text: '#c678dd', border: 'rgba(198, 120, 221, 0.25)' },
  custom:   { bg: 'rgba(107, 114, 128, 0.1)', text: '#8b8fa3', border: 'rgba(107, 114, 128, 0.25)' },
};

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Date Created' },
  { value: 'updated', label: 'Date Updated' },
  { value: 'usageCount', label: 'Most Used' },
  { value: 'table', label: 'Table' },
  { value: 'category', label: 'Category' },
];


// ============================================================
// Detection metadata vocabularies (schema v4)
//
// Until v4 a query record had eleven fields and not one of them was detection metadata,
// so the library could not answer the two questions that justify keeping one: "what is my
// ATT&CK coverage?" and "is this rule still valid?". ATT&CK IDs could only be smuggled into
// free-text tags, where T1059.001 and T1059.01 are indistinguishable and unvalidatable.
// ============================================================

// The 14 MITRE ATT&CK Enterprise tactics, in kill-chain order.
const ATTACK_TACTICS = [
  'reconnaissance', 'resource-development', 'initial-access', 'execution', 'persistence',
  'privilege-escalation', 'defense-evasion', 'credential-access', 'discovery',
  'lateral-movement', 'collection', 'command-and-control', 'exfiltration', 'impact',
];

// Txxxx or Txxxx.yyy. Anchored so a typo like T1059.01 is rejected rather than stored.
const TECHNIQUE_REGEX = /^T\d{4}(\.\d{3})?$/;

const SEVERITIES = ['Informational', 'Low', 'Medium', 'High', 'Critical'];
const CONFIDENCES = ['Low', 'Medium', 'High'];

// What the query is FOR, which is orthogonal to the analyst-intent CATEGORIES above and
// determines how it would be deployed.
const QUERY_TYPES = ['AnalyticsRule', 'NRT', 'Hunting', 'Investigation', 'Workbook'];

const PLATFORMS = [
  'Windows', 'Linux', 'macOS', 'Azure', 'AWS', 'GCP', 'Office365', 'Identity', 'Network',
];

// Sentinel entity types usable in an analytics rule's entity mappings.
const ENTITY_TYPES = [
  'Account', 'Host', 'IP', 'URL', 'FileHash', 'File', 'Process', 'Mailbox', 'MailMessage',
  'CloudApplication', 'AzureResource', 'DNS', 'RegistryKey', 'Malware',
];

// KQL timespan literal, e.g. 7d, 90m, 1h, 30s.
const TIMESPAN_REGEX = /^\d+(\.\d+)?(d|h|m|s|ms)$/;

// Loose semver, used for per-rule versioning.
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

// ISO calendar date (no time), used for the review cadence.
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const STORAGE_KEY = 'kql-store:data';
const BACKUP_KEY = 'kql-store:backup';
const HEALTH_TEST_KEY = 'kql-store:health-test';
const CURRENT_SCHEMA_VERSION = 4;
const SAVE_DEBOUNCE_MS = 2000;
const BACKUP_THROTTLE_MS = 60000;
const MAX_OP_LOG = 50;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export {
  CATEGORIES, CATEGORY_COLORS, CATEGORY_MIGRATION, SENTINEL_TABLES, DEFENDER_TABLES,
  ALL_KNOWN_TABLES, TABLE_STYLES, SORT_OPTIONS, STORAGE_KEY, BACKUP_KEY, HEALTH_TEST_KEY,
  CURRENT_SCHEMA_VERSION, SAVE_DEBOUNCE_MS, BACKUP_THROTTLE_MS, MAX_OP_LOG, UUID_REGEX,
  ATTACK_TACTICS, TECHNIQUE_REGEX, SEVERITIES, CONFIDENCES, QUERY_TYPES, PLATFORMS,
  ENTITY_TYPES, TIMESPAN_REGEX, SEMVER_REGEX, ISO_DATE_REGEX,
};
