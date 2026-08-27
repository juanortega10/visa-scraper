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

/**
 * Portal-emitted state of a group card, read from the container's class attribute:
 *   <div class='application attend_appointment card success'>  → 'attend_appointment'
 *   <div class='application appointment card secondary'>       → 'appointment'
 *   <div class='alert application card needs_payment'>         → 'needs_payment'
 *
 * The class token is the reliable signal. The visible "Estado actual" text is not:
 * on the same es-co page the portal renders "Cita Asistir" for one card and the
 * untranslated "Appointment" for another, and it changes with the account locale.
 */
export interface GroupStatus {
  /** State token from the card class (e.g. 'needs_payment'), or null if the page has no card markup. */
  token: string | null;
  /** Visible "Estado actual" text, for logs and support. Locale-dependent — never branch on it. */
  text: string | null;
}

/** Card class tokens the portal reuses for layout/color. Never a state. */
const CARD_LAYOUT_TOKENS = new Set([
  'application', 'card', 'alert', 'success', 'secondary', 'primary', 'warning',
  'info', 'row', 'column', 'columns', 'callout', 'expanded',
]);

/**
 * States in which the portal cannot hold a consular appointment for the group, so
 * the bot has nothing to poll or move. `needs_payment` = the visa fee (arancel) is
 * unpaid: the card offers no consulate/ASC address and no appointment date.
 *
 * Deliberately a deny-list, not an allow-list: an unknown state stays usable, so a
 * new portal state never silently drops a paying client's group.
 */
const NON_SCHEDULABLE_STATES = new Set(['needs_payment']);

/** True when the group's portal state allows a consular appointment to exist. */
export function isSchedulableGroup(group: { status: GroupStatus }): boolean {
  const { token } = group.status;
  if (!token) return true; // no card markup (older pages, stripped fixtures) — stay permissive
  return !NON_SCHEDULABLE_STATES.has(token);
}

export interface GroupInfo {
  scheduleId: string;
  /** Portal state of the card that owns this schedule. */
  status: GroupStatus;
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
 * Locate every application card in the page with its state token and visible label.
 * Returned in document order with the offset where the card opens, so each schedule
 * can be matched to the card that contains it.
 */
function extractCardStates(html: string): Array<{ start: number; status: GroupStatus }> {
  const cards: Array<{ start: number; status: GroupStatus }> = [];
  // Only cards that wrap an application. Support single and double quoted class attrs.
  const cardRegex = /<div\b[^>]*\bclass=['"]([^'"]*\bapplication\b[^'"]*\bcard\b[^'"]*|[^'"]*\bcard\b[^'"]*\bapplication\b[^'"]*)['"]/g;
  let m;
  while ((m = cardRegex.exec(html)) !== null) {
    const tokens = m[1]!.split(/\s+/).filter(Boolean);
    const token = tokens.find((t) => !CARD_LAYOUT_TOKENS.has(t)) ?? null;
    // The visible label sits in the card header: <h4 class='status'><small>…</small><br> TEXT
    const header = html.slice(m.index, m.index + 600);
    const textMatch = header.match(/<h4\b[^>]*\bclass=['"][^'"]*\bstatus\b[^'"]*['"][^>]*>[\s\S]*?<br\s*\/?>\s*([^<]+)/);
    cards.push({ start: m.index, status: { token, text: textMatch?.[1]?.trim() || null } });
  }
  return cards;
}

/** State of the card that owns `offset` = the last card opened at or before it. */
function statusForOffset(cards: Array<{ start: number; status: GroupStatus }>, offset: number): GroupStatus {
  let found: GroupStatus = { token: null, text: null };
  for (const c of cards) {
    if (c.start > offset) break;
    found = c.status;
  }
  return found;
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

  const cards = extractCardStates(html);

  return boundaries.map(({ id, start }, i) => {
    const end = boundaries[i + 1]?.start ?? html.length;

    // Backwards expansion: capture the <table> that precedes the first schedule link,
    // since gear links (/applicants/{id}) sit *after* the applicant name/passport cells.
    // Exception: if there's already a <table> *within* [start, end] (e.g. a "Continuar"
    // button appears before the applicant table), names are already after `start` — skip
    // backwards expansion to avoid bleeding into the previous group's table.
    const prevBoundary = i > 0 ? boundaries[i - 1]!.start : 0;
    const forwardTableIdx = html.indexOf('<table', start);
    const tableIdx = html.lastIndexOf('<table', start);
    const sectionStart = (forwardTableIdx !== -1 && forwardTableIdx < end)
      ? start
      : (tableIdx >= prevBoundary ? tableIdx : start);
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
      status: statusForOffset(cards, start),
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

// ── Tope de reprogramaciones del portal ──────────────────────────────────────

/**
 * Tope duro que impone el portal, leido de su propia pagina de advertencia.
 *
 * NO confundir con `bots.maxReschedules`, que es NUESTRO presupuesto: cuantos
 * movimientos autorizamos para ese bot. Son dos numeros distintos y a proposito:
 *
 *   portalMax       lo fija el portal. Peru = 2. Al llegar, la cita se BLOQUEA.
 *   maxReschedules  lo fijamos nosotros. Puede ser menor, para dejar reserva.
 *
 * El limite efectivo es el menor de los dos.
 */
export interface RescheduleLimit {
  /** Maximo que permite el portal. `null` si la pagina no lo dice. */
  max: number | null;
  /** Cuantos le quedan segun el portal. `null` si la pagina no lo dice. */
  remaining: number | null;
}

/**
 * Lee el tope de la pagina de ADVERTENCIA (`/schedule/{id}/appointment` SIN el
 * parametro `confirmed_limit_message=1`). Con ese parametro la advertencia se
 * salta y sale el formulario, entonces ahi el numero NO aparece.
 *
 * Texto real de es-pe, medido el 2026-08-27:
 *   "Hay un numero maximo de 2 cancelaciones/reprogramaciones permitidas por
 *    este servicio. Le quedan 1 intentos antes de alcanzar el limite."
 */
export function parseRescheduleLimit(html: string): RescheduleLimit {
  // El portal sirve la misma frase con acentos reales o con entidades HTML,
  // segun la pagina. Se normalizan antes de buscar.
  const ENTITIES: Record<string, string> = {
    '&nbsp;': ' ', '&aacute;': 'a', '&eacute;': 'e', '&iacute;': 'i',
    '&oacute;': 'o', '&uacute;': 'u', '&ntilde;': 'n', '&amp;': '&',
  };
  const t = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ');
  const max = t.match(/n[uú]mero m[aá]ximo de\s+(\d+)/i)
    ?? t.match(/maximum of\s+(\d+)\s+(?:cancellation|reschedul)/i)
    ?? t.match(/nombre maximum de\s+(\d+)/i)
    ?? t.match(/maximum de\s+(\d+)/i);
  const remaining = t.match(/[Ll]e quedan\s+(\d+)/i)
    ?? t.match(/[Yy]ou have\s+(\d+)\s+(?:attempts?|reschedules?)\s+remaining/i)
    ?? t.match(/(\d+)\s+tentatives?\s+restantes?/i)
    ?? t.match(/(\d+)\s+(?:attempts?|intentos?)\s+(?:remaining|restantes?)/i);
  return { max: max ? Number(max[1]) : null, remaining: remaining ? Number(remaining[1]) : null };
}

/**
 * Cuantos movimientos quedan de verdad, cruzando las dos fuentes.
 * Manda el menor. Si el portal no dijo nada, manda nuestro presupuesto.
 */
export function effectiveRescheduleBudget(args: {
  portalRemaining: number | null | undefined;
  ourMax: number | null | undefined;
  ourCount: number;
}): { left: number; capBy: 'portal' | 'nuestro' | 'sin_tope' } {
  const ours = args.ourMax == null ? null : Math.max(0, args.ourMax - args.ourCount);
  const portal = args.portalRemaining == null ? null : Math.max(0, args.portalRemaining);
  if (ours == null && portal == null) return { left: Number.POSITIVE_INFINITY, capBy: 'sin_tope' };
  if (ours == null) return { left: portal!, capBy: 'portal' };
  if (portal == null) return { left: ours, capBy: 'nuestro' };
  return portal <= ours ? { left: portal, capBy: 'portal' } : { left: ours, capBy: 'nuestro' };
}

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

/**
 * Picks the facility id out of a `<select>` body.
 *
 * Prefers the `<option selected>` — that is the facility of the appointment the
 * account already holds, which is the city the bot must poll and reschedule
 * within. Falls back to the first numeric option only when the portal renders no
 * selection at all (an account with no appointment yet).
 *
 * Reading the first option instead of the selected one is what put bot 281
 * (es-mx) on Ciudad Juarez (65, the alphabetically first city, permanently empty)
 * while the real appointment lived in Mexico City (70), and what put bot 162
 * (fr-ca) on Calgary (89, first) instead of Vancouver (95). Both dropdowns list
 * cities alphabetically, so "first" and "selected" only coincide by accident —
 * and they always coincide for es-co/es-pe, which have a single consulate. That
 * is why the bug stayed invisible for 234 Colombian bots.
 */
function pickFacilityFromSelect(selectInner: string): string {
  const optionRegex = /<option([^>]*)>/g;
  let first = '';
  let match;
  while ((match = optionRegex.exec(selectInner)) !== null) {
    const attrs = match[1]!;
    const value = attrs.match(/value="(\d+)"/)?.[1];
    if (!value) continue; // placeholder option (value="")
    if (/\bselected\b/.test(attrs)) return value;
    if (!first) first = value;
  }
  return first;
}

export function extractFacilityIds(
  apptHtml: string,
  apptPageOk: boolean,
  locale: string,
): ExtractedFacilities {
  let consularFacilityId = '';
  if (apptPageOk) {
    // Look for <select ... consulate_appointment_facility_id ...> then the selected <option value="NN">
    // Use a tighter regex that stays within the <select>...</select> block
    const selectMatch = apptHtml.match(/<select[^>]+consulate_appointment_facility_id[^>]*>([\s\S]*?)<\/select>/);
    if (selectMatch) {
      consularFacilityId = pickFacilityFromSelect(selectMatch[1]!);
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
    // Look for <select ... asc_appointment_facility_id ...> then the selected <option value="NN">
    // (falls back to the first numeric option; placeholder value="" options are skipped)
    const selectMatch = apptHtml.match(/<select[^>]+asc_appointment_facility_id[^>]*>([\s\S]*?)<\/select>/);
    if (selectMatch) {
      ascFacilityId = pickFacilityFromSelect(selectMatch[1]!);
    }
  }
  if (!ascFacilityId) {
    const known = KNOWN_FACILITIES[locale];
    if (known?.asc) ascFacilityId = known.asc;
  }

  return { consularFacilityId, ascFacilityId };
}
