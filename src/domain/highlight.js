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

  // Negated operators, matched before every keyword pass. `!` is not a word character, so a
  // \b-anchored keyword happily matches the tail of `!contains` and leaves a bare `!`
  // behind — the one character that inverts the meaning of the predicate would be the only
  // part of it left unstyled, which is precisely backwards. has_any and has_all are matched
  // by the multi-word pass below, so this has to come first, not merely before the single
  // keywords. The tail uses (?!\w) rather than \b so that `!in~` matches in full: `~` is not
  // a word character, so \b after it would silently fall back to matching only `!in`.
  const negated = [
    'startswith_cs','contains_cs','endswith_cs','startswith','hasprefix','hassuffix','endswith',
    'contains','between','has_all','has_any','has_cs','has','in~','in',
  ];
  r = r.replace(new RegExp('!(?:' + negated.join('|') + ')(?!\\w)', 'g'),
    (m) => ph(span('#c678dd', m)));

  // Multi-word and hyphenated keywords.
  // These MUST be matched before the single-keyword pass below, or `project-away` is styled
  // as the keyword `project` followed by unstyled text, and the reader cannot tell a
  // column-selecting query from a column-dropping one at a glance.
  const multiKw = [
    'matches\\s+regex','order\\s+by','sort\\s+by','has_any','has_all','mv-expand','mv-apply',
    'make-series','make_set','make_list','arg_max','arg_min','pack_all','replace_string',
    'project-reorder','project-rename','project-away','project-keep','top-nested',
    'partition\\s+by','parse-where','parse-kv',
  ];
  r = r.replace(new RegExp('\\b(' + multiKw.join('|') + ')\\b', 'gi'), (m) => ph(span('#c678dd', m)));

  // Functions (word + opening paren)
  const fns = [
    'series_decompose_anomalies','geo_info_from_ip_address','base64_decode_tostring',
    'geo_distance_2points','geo_point_to_geohash','series_decompose','bag_remove_keys',
    'format_datetime','format_timespan','array_sort_asc','datetime_diff','ingestion_time',
    'array_length','array_concat','parse_urlquery','hash_sha256','replace_string','dcount_hll',
    'materialized_view','ipv4_is_private','has_any_index','array_index_of','set_difference',
    'set_intersect','ipv4_is_match','ipv6_is_match','datetime_add','datetime_part','set_union',
    'isnotempty','row_number','pack_array','trim_start','todatetime','totimespan','todynamic',
    'url_decode','parse_json','parse_path','parse_url','parse_csv','parse_xml','bag_merge',
    'parse_ipv4','parse_ipv6','startofmonth','startofweek','startofyear','startofday',
    'endofmonth','endofweek','endofyear','endofday','dayofweek','dayofyear','monthofyear',
    'hll_merge','trim_end','bag_keys','make_set','make_list','make_bag','percentile','substring',
    'todouble','isempty','tostring','toupper','tolower','replace','extract','treepath','coalesce',
    'ceiling','indexof','countof','variance','toreal','tolong','toint','round','floor','strlen',
    'strcat','split','dcount','count','stdev','sqrt','trim','prev','next','case','pack','range',
    'repeat','bin_at','tobool','toguid','zip','sum','avg','min','max','iif','iff','pow','log',
    'now','ago','hll',
  ];
  r = r.replace(new RegExp('\\b(' + fns.join('|') + ')(\\s*\\()', 'g'), (_, fn, p) => ph(span('#61afef', fn)) + p);

  // Single keywords
  const kws = [
    'summarize','materialize','startswith','getschema','serialize','endswith','contains','datetime',
    'evaluate','toscalar','datatable','distinct','timespan','between','dynamic','project','typeof',
    'externaldata','startswith_cs','contains_cs','endswith_cs','withsource','isfuzzy','hasprefix',
    'hassuffix','partition','consume','has_cs','scan','step','declare','facet','sample',
    'invoke','lookup','extend','render','search','where','union','count','print','parse','join',
    'take','kind','find','desc','asc','top','let','bin','set','has','not','and','now','ago',
    'on','as','by','in','or',
  ];
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
