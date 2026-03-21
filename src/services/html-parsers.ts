// Pure HTML parsing functions extracted from discoverAccount() for testability.
// These operate on raw HTML strings with no side effects or network calls.

// Month map for parsing dates (shared with visa-client.ts)
const MONTH_MAP: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04',
  mayo: '05', junio: '06', julio: '07', agosto: '08',
  septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

// Known facility IDs per locale (fallback when appointment page is inaccessible)
const KNOWN_FACILITIES: Record<string, { consular: string; asc: string }> = {
  'es-co': { consular: '25', asc: '26' },
  'es-pe': { consular: '115', asc: '' },
};

export function parseApptDate(text: string): { date: string; time: string } | null {
  // Match: "9 marzo, 2026, 08:15" — month can contain accented chars (e.g. março)
  const match = text.match(/(\d{1,2})\s+([a-zA-ZÀ-ÿ]+),\s*(\d{4}),\s*(\d{2}:\d{2})/);
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

export interface GroupInfo {
  scheduleId: string;
  applicantIds: string[];
  applicantNames: string[];
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
    const section = html.slice(start, end);

    const applicantIds: string[] = [];
    const apptSeen = new Set<string>();
    for (const m of section.matchAll(/\/applicants\/(\d+)/g)) {
      if (!apptSeen.has(m[1]!)) { apptSeen.add(m[1]!); applicantIds.push(m[1]!); }
    }

    const { currentConsularDate, currentConsularTime, currentCasDate, currentCasTime } =
      extractAppointments(section);

    // Pass apptPageOk=false so it uses the <td> fallback on the section HTML
    const applicantNames = extractApplicantNames(section, '', false);

    return { scheduleId: id, applicantIds, applicantNames, currentConsularDate, currentConsularTime, currentCasDate, currentCasTime };
  });
}

export interface ExtractedFacilities {
  consularFacilityId: string;
  ascFacilityId: string;
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
