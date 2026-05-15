// Pure HTML parsing functions extracted from discoverAccount() for testability.
// These operate on raw HTML strings with no side effects or network calls.

// Month name → "MM". Built at module load from Intl.DateTimeFormat for every
// language that appears in VALID_LOCALES, plus manual seeds for es/en so the
// map stays correct even if Intl output drifts between Node versions.
const MONTH_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {
    // Manual seeds — authoritative for the two locales we ship most.
    enero: '01', febrero: '02', marzo: '03', abril: '04',
    mayo: '05', junio: '06', julio: '07', agosto: '08',
    septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
    // Russian dates appear in genitive case ("9 марта 2026"); Intl returns the
    // nominative ("март") so seed the genitive forms manually.
    января: '01', февраля: '02', марта: '03', апреля: '04',
    мая: '05', июня: '06', июля: '07', августа: '08',
    сентября: '09', октября: '10', ноября: '11', декабря: '12',
  };
  // Cover every language code that shows up in VALID_LOCALES.
  const langs = ['es', 'en', 'pt', 'fr', 'it', 'nl', 'ht', 'ar', 'ru', 'am', 'kk', 'ky', 'uz', 'de'];
  for (const lang of langs) {
    for (let m = 0; m < 12; m++) {
      try {
        const name = new Intl.DateTimeFormat(lang, { month: 'long', timeZone: 'UTC' })
          .format(new Date(Date.UTC(2026, m, 1)))
          .toLowerCase()
          .replace(/\.$/, '')          // trim abbreviation dots ("ene.")
          .replace(/\s+г\.?$/u, '')    // strip Russian "г." suffix if Intl adds it
          .trim();
        if (name && !map[name]) map[name] = String(m + 1).padStart(2, '0');
      } catch { /* unsupported locale, skip */ }
    }
  }
  return map;
})();

// Known facility IDs per locale (fallback when appointment page is inaccessible)
const KNOWN_FACILITIES: Record<string, { consular: string; asc: string }> = {
  'es-co': { consular: '25', asc: '26' },
  'es-pe': { consular: '115', asc: '' },
};

/** Whether the parser can synthesize facility IDs from the locale alone.
 *  When false, callers must fetch the live appointment page so
 *  `extractFacilityIds` can parse the `<select>` blocks instead. */
export function hasKnownFacilities(locale: string): boolean {
  return locale in KNOWN_FACILITIES;
}

export function parseApptDate(text: string): { date: string; time: string } | null {
  // Match: "9 marzo, 2026, 08:15" or "9 mars 2026, 08:15" — comma between month
  // and year is optional (French/Portuguese omit it). \p{L} accepts any Unicode
  // letter (Cyrillic, Arabic, accented Latin, etc.).
  const match = text.match(/(\d{1,2})\s+(\p{L}+),?\s+(\d{4}),\s*(\d{2}:\d{2})/u);
  if (!match) return null;
  const [, day, monthName, year, time] = match;
  const month = MONTH_MAP[monthName!.toLowerCase()];
  if (!month) return null;
  return { date: `${year}-${month}-${day!.padStart(2, '0')}`, time: time! };
}

export function extractScheduleId(groupsHtml: string): string | null {
  const match = groupsHtml.match(/\/schedule\/(\d+)/);
  return match?.[1] ?? null;
}

export function extractApplicantIdsFromGroups(groupsHtml: string): string[] {
  // Exclude archived groups section — contains applicant IDs from old/removed groups
  const archivedIdx = groupsHtml.search(/[Aa]rchived\s*[Gg]roups/);
  const html = archivedIdx > -1 ? groupsHtml.slice(0, archivedIdx) : groupsHtml;

  const regex = /\/applicants\/(\d+)/g;
  const seen = new Set<string>();
  const ids: string[] = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    if (!seen.has(m[1]!)) {
      seen.add(m[1]!);
      ids.push(m[1]!);
    }
  }
  return ids;
}

/**
 * Extract schedule→applicant pairings from the gear dropdown links on the groups page.
 *
 * Each applicant row has links like:
 *   href="/es-co/niv/schedule/{scheduleId}/applicants/{applicantId}"   (Detalles)
 *   href="/es-co/niv/schedule/{scheduleId}/applicants/{applicantId}/edit"  (Editar)
 *
 * Using the combined pattern avoids ambiguity with navigation links that only have /schedule/{id}.
 * Each applicant appears multiple times — we deduplicate per schedule.
 */
export function extractScheduleApplicantPairs(groupsHtml: string): Map<string, string[]> {
  const archivedIdx = groupsHtml.search(/[Aa]rchived\s*[Gg]roups/);
  const html = archivedIdx > -1 ? groupsHtml.slice(0, archivedIdx) : groupsHtml;

  const result = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();

  for (const m of html.matchAll(/\/schedule\/(\d+)\/applicants\/(\d+)/g)) {
    const scheduleId = m[1]!;
    const applicantId = m[2]!;
    if (!seen.has(scheduleId)) {
      seen.set(scheduleId, new Set());
      result.set(scheduleId, []);
    }
    if (!seen.get(scheduleId)!.has(applicantId)) {
      seen.get(scheduleId)!.add(applicantId);
      result.get(scheduleId)!.push(applicantId);
    }
  }
  return result;
}

export function extractApplicantIdsFromAppointment(apptHtml: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  function addUnique(id: string) {
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }

  // Primary: name="applicants[]" ... value="12345"
  const regex1 = /name="applicants\[\]"[^>]*value="(\d+)"/g;
  let m;
  while ((m = regex1.exec(apptHtml)) !== null) {
    addUnique(m[1]!);
  }
  if (ids.length > 0) return ids;

  // Reverse attribute order: value before name
  const regex2 = /value="(\d+)"[^>]*name="applicants\[\]"/g;
  while ((m = regex2.exec(apptHtml)) !== null) {
    addUnique(m[1]!);
  }
  return ids;
}

export function extractApplicantNames(
  groupsHtml: string,
  apptHtml: string,
  apptPageOk: boolean,
): string[] {
  const names: string[] = [];

  // Primary: text nodes after checkboxes on appointment page
  if (apptPageOk) {
    const nameRegex = /name="applicants\[\]"[^>]*\/>\s*\n?\s*([^\n<]+)/g;
    let m;
    while ((m = nameRegex.exec(apptHtml)) !== null) {
      const name = m[1]!.trim();
      if (name) names.push(name);
    }
  }
  if (names.length > 0) return names;

  // Fallback: extract names from groups page <td> tags
  // Names appear as UPPER CASE or Title Case — exclude passport numbers and short strings.
  // Use [^<]+ to capture any non-tag content, then validate with heuristics.
  const tdRegex = /<td>\s*([^<]+?)\s*<\/td>/g;
  let tdMatch;
  while ((tdMatch = tdRegex.exec(groupsHtml)) !== null) {
    const candidate = tdMatch[1]!.trim();
    // Must be at least 2 words (first + last name)
    if (!candidate.includes(' ')) continue;
    // Skip passport numbers or codes (contain digits)
    if (/\d/.test(candidate)) continue;
    // Skip very short strings
    if (candidate.length < 5) continue;
    // Must look like a name: only letters, spaces, accents, hyphens, apostrophes
    if (!/^[A-Za-zÀ-ÿ][\sA-Za-zÀ-ÿ''-]+$/.test(candidate)) continue;
    // Normalize to Title Case — split on spaces to handle accented chars correctly
    const titleCase = candidate.split(/\s+/).map(w =>
      w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    ).join(' ');
    names.push(titleCase);
  }
  return names;
}

export interface ExtractedAppointments {
  currentConsularDate: string | null;
  currentConsularTime: string | null;
  currentCasDate: string | null;
  currentCasTime: string | null;
}

export function extractAppointments(groupsHtml: string): ExtractedAppointments {
  let currentConsularDate: string | null = null;
  let currentConsularTime: string | null = null;
  let currentCasDate: string | null = null;
  let currentCasTime: string | null = null;

  // Support both single and double quotes around the class attribute
  const consularMatch = groupsHtml.match(/<p\s+class=['"]consular-appt['"]>[\s\S]*?<\/strong>\s*\n?\s*([^<&]+)/);
  if (consularMatch?.[1]) {
    const parsed = parseApptDate(consularMatch[1].trim());
    if (parsed) { currentConsularDate = parsed.date; currentConsularTime = parsed.time; }
  }

  const casMatch = groupsHtml.match(/<p\s+class=['"]asc-appt['"]>[\s\S]*?<\/strong>\s*\n?\s*([^<&]+)/);
  if (casMatch?.[1]) {
    const parsed = parseApptDate(casMatch[1].trim());
    if (parsed) { currentCasDate = parsed.date; currentCasTime = parsed.time; }
  }

  return { currentConsularDate, currentConsularTime, currentCasDate, currentCasTime };
}

/**
 * Extract per-applicant visa type labels from the groups page applicant table.
 *
 * Each <tr> has columns: Name | Passport | DS-160 | Tipo de Visa | Estado | Actions.
 * The visa-type cell is the 2nd `<td class='show-for-medium'>` per row (DS-160 is the 1st).
 *
 * Returns labels in DOM order — same length as applicants in the section, when parseable.
 * Empty array when the column is absent (older pages, Peru variants, or stripped fixtures).
 */
export function extractApplicantVisaTypes(sectionHtml: string): string[] {
  const labels: string[] = [];
  // Match <tr>...</tr>, then within it find the 2nd <td class='show-for-medium'>...</td>.
  const trRegex = /<tr\b[\s\S]*?<\/tr>/g;
  let trMatch;
  while ((trMatch = trRegex.exec(sectionHtml)) !== null) {
    const tr = trMatch[0];
    // Skip <thead> rows — they contain <th>, not <td class='show-for-medium'>
    if (/<th\b/.test(tr)) continue;
    const tdRegex = /<td\s+class=['"]show-for-medium['"][^>]*>([\s\S]*?)<\/td>/g;
    const cells: string[] = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(tr)) !== null) {
      cells.push(tdMatch[1]!.trim());
    }
    // Visa type is the 2nd show-for-medium cell. Skip rows where it doesn't look like a
    // visa label (e.g., status link cells when DS-160 is missing).
    if (cells.length >= 2) {
      const candidate = cells[1]!.replace(/\s+/g, ' ').trim();
      // A real visa label starts with a letter+digit prefix (B1, F1, J1, T1, etc.) or a
      // word like "Inmigrante". Reject pure markup or numeric-only.
      if (/^[A-Z][\dA-Z][/\dA-Z-]*\b/.test(candidate) || /^[A-Z][a-záéíóúñ]+\b/.test(candidate)) {
        labels.push(candidate);
      }
    }
  }
  return labels;
}

/**
 * Normalize a raw visa-type label to a canonical category code.
 *
 * Examples:
 *   "B1/B2 Negocios y turismo (visitante temporal)" → "B1/B2"
 *   "F1 Estudiante"                                 → "F1"
 *   "J1 Visitante de intercambio..."                → "J1"
 *   "B-1 Business..."                               → "B1"   (hyphens stripped)
 *   "TN Profesional del NAFTA..."                   → "TN"
 *   "C1/D Tripulante en tránsito"                   → "C1/D"
 *
 * Returns null if no recognizable visa-code prefix is found.
 */
export function normalizeVisaCategory(rawLabel: string | null | undefined): string | null {
  if (!rawLabel) return null;
  const trimmed = rawLabel.trim();
  // Match a leading visa code: letter(s), optional digit(s), optional /letter+digits.
  // Hyphens (B-1, F-1) are accepted then stripped.
  const m = trimmed.match(/^([A-Z]+\d*[A-Z]?)(?:[-]?(\d+))?(?:\s*\/\s*([A-Z]+\d*[A-Z]?))?/);
  if (!m) return null;
  const [, prefix, digits, slashPart] = m;
  let code = prefix!;
  if (digits) code = `${code.replace(/-/g, '')}${digits}`;
  if (slashPart) code = `${code}/${slashPart.replace(/-/g, '')}`;
  // Sanity: must start with a letter and be ≤8 chars (e.g. "H1B/H4" still fits).
  if (!/^[A-Z]/.test(code) || code.length > 8) return null;
  return code;
}

/**
 * Pick the most-common normalized visa category from a list of raw labels.
 * Ties broken by first occurrence. Used as the bot-level "primary" category.
 */
export function pickPrimaryVisaCategory(rawLabels: string[]): string | null {
  if (rawLabels.length === 0) return null;
  const counts = new Map<string, number>();
  for (const label of rawLabels) {
    const code = normalizeVisaCategory(label);
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestN = -1;
  for (const [code, n] of counts) {
    if (n > bestN) { best = code; bestN = n; }
  }
  return best;
}

export interface GroupInfo {
  scheduleId: string;
  applicantIds: string[];
  applicantNames: string[];
  /** Per-applicant raw visa-type labels in DOM order (parallel to applicantIds when complete). */
  applicantVisaTypes: string[];
  /** Most common normalized visa category for the group (e.g. "B1/B2", "F1"). null if unparseable. */
  primaryVisaCategory: string | null;
  currentConsularDate: string | null;
  currentConsularTime: string | null;
  currentCasDate: string | null;
  currentCasTime: string | null;
}

/**
 * Parse all schedule groups from the /groups/{userId} page.
 * Splits HTML by the first occurrence of each unique schedule ID,
 * then extracts applicant IDs and dates from each section.
 */
export function extractGroups(groupsHtml: string): GroupInfo[] {
  // Exclude archived groups section
  const archivedIdx = groupsHtml.search(/[Aa]rchived\s*[Gg]roups/);
  const html = archivedIdx > -1 ? groupsHtml.slice(0, archivedIdx) : groupsHtml;

  // Collect the first occurrence position of each unique schedule ID.
  const seen = new Set<string>();
  const boundaries: Array<{ id: string; start: number }> = [];

  for (const m of html.matchAll(/\/schedule\/(\d+)\//g)) {
    if (!seen.has(m[1]!)) {
      seen.add(m[1]!);
      boundaries.push({ id: m[1]!, start: m.index! });
    }
  }

  if (boundaries.length === 0) return [];

  return boundaries.map(({ id, start }, i) => {
    const end = boundaries[i + 1]?.start ?? html.length;

    // Expand the section start backwards to capture the surrounding <table>, since the first
    // /schedule/{id}/ link sits *after* the first row's name/passport/DS-160/visa-type cells.
    // Bound expansion by the previous group boundary to avoid cross-group contamination.
    const prevBoundary = i > 0 ? boundaries[i - 1]!.start : 0;
    const tableIdx = html.lastIndexOf('<table', start);
    const sectionStart = tableIdx >= prevBoundary ? tableIdx : start;
    const section = html.slice(sectionStart, end);

    const applicantIds: string[] = [];
    const apptSeen = new Set<string>();
    for (const m of section.matchAll(/\/applicants\/(\d+)/g)) {
      if (!apptSeen.has(m[1]!)) { apptSeen.add(m[1]!); applicantIds.push(m[1]!); }
    }

    const { currentConsularDate, currentConsularTime, currentCasDate, currentCasTime } =
      extractAppointments(section);

    // Pass apptPageOk=false so it uses the <td> fallback on the section HTML
    const applicantNames = extractApplicantNames(section, '', false);

    const applicantVisaTypes = extractApplicantVisaTypes(section);
    const primaryVisaCategory = pickPrimaryVisaCategory(applicantVisaTypes);

    return {
      scheduleId: id,
      applicantIds,
      applicantNames,
      applicantVisaTypes,
      primaryVisaCategory,
      currentConsularDate,
      currentConsularTime,
      currentCasDate,
      currentCasTime,
    };
  });
}

export interface VisaClassFromEdit {
  /** Server-canonical numeric ID (e.g. 1=B1, 2=B1/B2, 3=B2, 11=F1, 22/88=J1, 30=M1, 49=TN). */
  classId: number;
  /** Full localized label, e.g. "B1/B2 Negocios y turismo (visitante temporal)". */
  label: string;
}

/**
 * Extract the *selected* visa class from the applicant edit page.
 *
 * Source: <select name="applicant[visa_class_id]"> ... <option selected="selected" value="N">Label</option>
 *
 * This is the most robust source for visa type — server-canonical numeric ID, locale-independent.
 * Used by the async enrichment path (not by discovery, which keeps the zero-cost groups-page parse).
 *
 * Returns null if the select is not present or no option is marked selected.
 */
export function extractVisaClassFromEditPage(editHtml: string): VisaClassFromEdit | null {
  // Locate the visa_class_id select block (not previous_visa_class_id — different field).
  // Pin via name="applicant[visa_class_id]" to avoid the previous-class field.
  const selectMatch = editHtml.match(
    /<select[^>]+name=["']applicant\[visa_class_id\]["'][^>]*>([\s\S]*?)<\/select>/,
  );
  if (!selectMatch) return null;
  const block = selectMatch[1]!;

  // Find the option marked selected. Tolerate both attribute orders:
  //   <option selected="selected" value="2">…</option>
  //   <option value="2" selected="selected">…</option>
  const orderA = block.match(/<option[^>]*\bselected=["']selected["'][^>]*\bvalue=["'](\d+)["'][^>]*>([\s\S]*?)<\/option>/);
  const orderB = block.match(/<option[^>]*\bvalue=["'](\d+)["'][^>]*\bselected=["']selected["'][^>]*>([\s\S]*?)<\/option>/);
  const m = orderA ?? orderB;
  if (!m) return null;

  const classId = parseInt(m[1]!, 10);
  if (!Number.isFinite(classId)) return null;
  const label = m[2]!.replace(/\s+/g, ' ').trim();
  if (!label) return null;
  return { classId, label };
}

export interface ExtractedFacilities {
  consularFacilityId: string;
  ascFacilityId: string;
}

/**
 * Detect transient backend overload messages in localized appointment HTML.
 * When present, available slots / facility options may be missing even though
 * the page returned HTTP 200. Callers should treat extraction failures as
 * retriable rather than authoritative.
 */
export function detectOverloadError(html: string): boolean {
  const markers = [
    'système est surchargé',          // fr
    'system is overloaded',           // en
    'sistema está sobrecargado',      // es
    'sistema sobrecarregado',         // pt
    'sistema è sovraccarico',         // it
    'systeem is overbelast',          // nl
    'systeem overbelast',             // nl variant
  ];
  const lower = html.toLowerCase();
  return markers.some((m) => lower.includes(m));
}

/**
 * Sentinel error thrown when the appointment page returned 200 but lacks the
 * facility form structure (overload, partial render, or page-level block).
 * Distinct from a legitimate "country has no ASC" scenario.
 */
export class AppointmentFormMissingError extends Error {
  constructor(public readonly hasOverloadMarker: boolean) {
    super(hasOverloadMarker ? 'appointment_form_missing_overload' : 'appointment_form_missing');
    this.name = 'AppointmentFormMissingError';
  }
}

export function extractFacilityIds(
  apptHtml: string,
  apptPageOk: boolean,
  locale: string,
): ExtractedFacilities {
  let consularFacilityId = '';
  if (apptPageOk) {
    // Look for <select ... consulate_appointment_facility_id ...> then first <option value="NN">
    // Use a tighter regex that stays within the <select>...</select> block
    const selectMatch = apptHtml.match(/<select[^>]+consulate_appointment_facility_id[^>]*>([\s\S]*?)<\/select>/);
    if (selectMatch) {
      const optionMatch = selectMatch[1]!.match(/<option[^>]+value="(\d+)"/);
      if (optionMatch?.[1]) consularFacilityId = optionMatch[1];
    }
    // Guardrail: if we trust the live page (apptPageOk=true) and there's no
    // consular select at all, the form failed to render. Don't fall back to
    // KNOWN_FACILITIES silently — caller should retry.
    if (!consularFacilityId && !KNOWN_FACILITIES[locale]) {
      throw new AppointmentFormMissingError(detectOverloadError(apptHtml));
    }
  }
  if (!consularFacilityId) {
    const known = KNOWN_FACILITIES[locale];
    if (known) consularFacilityId = known.consular;
  }

  let ascFacilityId = '';
  if (apptPageOk) {
    // Look for <select ... asc_appointment_facility_id ...> then first non-empty <option value="NN">
    const selectMatch = apptHtml.match(/<select[^>]+asc_appointment_facility_id[^>]*>([\s\S]*?)<\/select>/);
    if (selectMatch) {
      // Find all options, pick first with a numeric value (skip empty/placeholder options)
      const optionRegex = /<option[^>]+value="(\d+)"/g;
      let optMatch;
      while ((optMatch = optionRegex.exec(selectMatch[1]!)) !== null) {
        if (optMatch[1]) { ascFacilityId = optMatch[1]; break; }
      }
    }
  }
  if (!ascFacilityId) {
    const known = KNOWN_FACILITIES[locale];
    if (known?.asc) ascFacilityId = known.asc;
  }

  return { consularFacilityId, ascFacilityId };
}
