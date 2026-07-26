// ============================================================
// KQL Syntax Highlighter
// (HTML-escaped input, placeholder-based to prevent double-matching)
// The highlightKQL function escapes all HTML entities (& < >)
// BEFORE inserting styled <span> tags with hardcoded inline
// color values only. This prevents any script injection.
// ============================================================
function highlightKQL(code) {
  if (!code || typeof code !== 'string') return '';

  // The placeholder prefix must be absent from the input. A query body containing a
  // literal token would otherwise be hit first by the restore loop below, swapping
  // highlighted fragments and leaving the real token as visible text. Escaping can only
  // push characters apart, never join them, so checking the raw input is sufficient.
  let mark = '__PH';
  while (code.includes(mark)) mark += 'X';

  const placeholders = [];
  const ph = (html) => { const i = placeholders.length; placeholders.push(html); return `${mark}${i}__`; };
  const span = (color, text, bold) =>
    `<span style="color:${color}${bold ? ';font-weight:bold' : ''}">${text}</span>`;

  // Escape HTML entities first to prevent injection
  let r = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Comments and strings must be matched in ONE pass so that whichever opens first wins.
  // Separate passes are mutually destructive: comments-first lets the // in a URL literal
  // ("https://portal.azure.com") open a comment that swallows the rest of the line and the
  // line after it; strings-first lets an apostrophe in a comment (// don't) open a string.
  r = r.replace(/\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (m) => ph(span(m.startsWith('//') ? '#5c6370' : '#98c379', m)));
  // Pipe operator at line starts
  r = r.replace(/^([ \t]*)(\|)/gm, (_, ws, pipe) => ws + ph(span('#00ff88', pipe, true)));

  // Table names (longest first)
  const tables = [
    'DeviceTvmSoftwareVulnerabilities','DeviceTvmSoftwareInventory','ThreatIntelligenceIndicator',
    'AADSpnSignInEventsBeta','DeviceImageLoadEvents','DeviceRegistryEvents','IdentityLogonEvents',
    'IdentityQueryEvents','IdentityDirectoryEvents','DeviceProcessEvents','DeviceNetworkEvents',
    'AADSignInEventsBeta','EmailAttachmentInfo','EmailPostDeliveryEvents','DeviceLogonEvents',
    'CommonSecurityLog','BehaviorEntities','BehaviorInfo','AzureDiagnostics',
    'DeviceFileEvents','CloudAppEvents','UrlClickEvents','SecurityAlert','SecurityEvent',
    'SecurityIncident','OfficeActivity','AzureActivity','AlertEvidence','EmailUrlInfo',
    'WindowsFirewall','WindowsEvent','DeviceEvents','EmailEvents','DeviceInfo',
    'SigninLogs','AuditLogs','AlertInfo','Heartbeat','DnsEvents','W3CIISLog','Usage','Syslog',
  ];
  r = r.replace(new RegExp('\\b(' + tables.join('|') + ')\\b', 'g'), (m) => ph(span('#e5c07b', m)));

  // Multi-word keywords
  const multiKw = [
    'matches\\s+regex','order\\s+by','sort\\s+by','has_any','has_all','mv-expand','mv-apply',
    'make-series','make_set','make_list','arg_max','arg_min','pack_all','replace_string',
  ];
  r = r.replace(new RegExp('\\b(' + multiKw.join('|') + ')\\b', 'gi'), (m) => ph(span('#c678dd', m)));

  // Functions (word + opening paren)
  const fns = [
    'base64_decode_tostring','geo_distance_2points','geo_point_to_geohash','bag_remove_keys',
    'format_datetime','format_timespan','array_sort_asc','datetime_diff','ingestion_time',
    'array_length','array_concat','parse_urlquery','hash_sha256','replace_string','dcount_hll',
    'isnotempty','row_number','pack_array','trim_start','todatetime','totimespan','todynamic',
    'url_decode','parse_json','parse_path','parse_url','parse_csv','parse_xml','bag_merge',
    'hll_merge','trim_end','bag_keys','make_set','make_list','make_bag','percentile','substring',
    'todouble','isempty','tostring','toupper','tolower','replace','extract','treepath','coalesce',
    'ceiling','indexof','countof','variance','toreal','tolong','toint','round','floor','strlen',
    'strcat','split','dcount','count','stdev','sqrt','trim','prev','next','case','pack','range',
    'repeat','zip','sum','avg','min','max','iff','pow','log','now','ago','hll',
  ];
  r = r.replace(new RegExp('\\b(' + fns.join('|') + ')(\\s*\\()', 'g'), (_, fn, p) => ph(span('#61afef', fn)) + p);

  // Single keywords
  const kws = [
    'summarize','materialize','startswith','getschema','serialize','endswith','contains','datetime',
    'evaluate','toscalar','datatable','distinct','timespan','between','dynamic','project','typeof',
    'invoke','lookup','extend','render','search','where','union','count','print','parse','join',
    'take','kind','find','desc','asc','top','let','bin','set','has','not','and','now','ago',
    'on','as','by','in','or',
  ];
  r = r.replace(/!in\b/g, (m) => ph(span('#c678dd', m)));
  r = r.replace(/!has\b/g, (m) => ph(span('#c678dd', m)));
  r = r.replace(new RegExp('\\b(' + kws.join('|') + ')\\b', 'g'), (m) => ph(span('#c678dd', m)));

  // Comparison operators (using escaped HTML entities for < >)
  r = r.replace(/[!=]=~?|[!=]~|&lt;=?|&gt;=?|&amp;&amp;|\|\|/g, (m) => ph(span('#56b6c2', m)));
  // Time literals
  r = r.replace(/\b(\d+(?:\.\d+)?)(d|h|m|s|ms|tick)\b/g, (m) => ph(span('#d19a66', m)));
  // Numbers
  r = r.replace(/\b\d+(?:\.\d+)?\b/g, (m) => ph(span('#d19a66', m)));

  // Restore placeholders in reverse order.
  // The replacement MUST stay a function: with a string replacement, $&, $`, $' and $$
  // are special patterns, and placeholders hold user query text — a body containing $'
  // re-inserts the rest of the output on every iteration and grows exponentially.
  for (let i = placeholders.length - 1; i >= 0; i--) {
    r = r.replace(`${mark}${i}__`, () => placeholders[i]);
  }
  return r;
}

export { highlightKQL };
