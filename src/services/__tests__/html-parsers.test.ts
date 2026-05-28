import { describe, it, expect } from 'vitest';
import {
  parseApptDate,
  extractScheduleId,
  extractApplicantIdsFromGroups,
  extractApplicantIdsFromAppointment,
  extractApplicantNames,
  extractAppointments,
  extractApplicantVisaTypes,
  normalizeVisaCategory,
  pickPrimaryVisaCategory,
  extractGroups,
  extractVisaClassFromEditPage,
  extractFacilityIds,
  detectOverloadError,
  AppointmentFormMissingError,
  hasKnownFacilities,
} from '../html-parsers.js';

// ── Fixtures ──────────────────────────────────────────

// Fixture A: Colombia, 2 applicants, Title Case names, consular + CAS
const GROUPS_A = `
<html>
<body>
<div class="mainContent">
  <table class="medium-6">
    <tr>
      <td><a href="/es-co/niv/schedule/12345678/applicants/10000001">Editar</a></td>
      <td>Maria Garcia Lopez</td>
      <td>AB123456</td>
    </tr>
    <tr>
      <td><a href="/es-co/niv/schedule/12345678/applicants/10000002">Editar</a></td>
      <td>Carlos Garcia Ruiz</td>
      <td>AB654321</td>
    </tr>
  </table>
  <p class='consular-appt'>
    <strong>Cita Consular:</strong>
    9 marzo, 2026, 08:15 Bogota Hora Local at Bogota
  </p>
  <p class='asc-appt'>
    <strong>Cita ASC:</strong>
    5 marzo, 2026, 10:45 BOGOTA Hora Local at Bogota ASC
  </p>
</div>
</body>
</html>`;

// Fixture B: Colombia, 4 applicants, UPPER CASE names
const GROUPS_B = `
<html>
<body>
<div class="mainContent">
  <table class="medium-6">
    <tr>
      <td><a href="/es-co/niv/schedule/87654321/applicants/20000001">Editar</a></td>
      <td>PEDRO ANTONIO MARTINEZ SILVA</td>
      <td>AT196756</td>
    </tr>
    <tr>
      <td><a href="/es-co/niv/schedule/87654321/applicants/20000002">Editar</a></td>
      <td>LUISA FERNANDA ROJAS DIAZ</td>
      <td>BA708103</td>
    </tr>
    <tr>
      <td><a href="/es-co/niv/schedule/87654321/applicants/20000003">Editar</a></td>
      <td>ANDRÉS FELIPE GÓMEZ LÓPEZ</td>
      <td>CC987654</td>
    </tr>
    <tr>
      <td><a href="/es-co/niv/schedule/87654321/applicants/20000004">Editar</a></td>
      <td>MARÍA JOSÉ HERNÁNDEZ RÍOS</td>
      <td>DD112233</td>
    </tr>
  </table>
  <p class='consular-appt'>
    <strong>Cita Consular:</strong>
    15 junio, 2026, 07:15 Bogota Hora Local at Bogota
  </p>
  <p class='asc-appt'>
    <strong>Cita ASC:</strong>
    12 junio, 2026, 09:30 BOGOTA Hora Local at Bogota ASC
  </p>
</div>
</body>
</html>`;

// Fixture C: Peru, 1 applicant, Title Case, no CAS
const GROUPS_C = `
<html>
<body>
<div class="mainContent">
  <table class="medium-6">
    <tr>
      <td><a href="/es-pe/niv/schedule/55555555/applicants/30000001">Editar</a></td>
      <td>Ana Maria Rodriguez Torres</td>
      <td>123456789</td>
    </tr>
  </table>
  <p class='consular-appt'>
    <strong>Consular Appointment:</strong>
    20 april, 2026, 10:00 Lima Local Time at Lima
  </p>
</div>
</body>
</html>`;

// Fixture D: Double-quoted class attributes + extra whitespace in <td>
const GROUPS_D = `
<html>
<body>
<div class="mainContent">
  <table>
    <tr>
      <td><a href="/en-ca/niv/schedule/99999999/applicants/40000001">Edit</a></td>
      <td>
        Jean-Pierre O'Brien
      </td>
      <td>XY987654</td>
    </tr>
  </table>
  <p class="consular-appt">
    <strong>Consular Appointment:</strong>
    3 january, 2027, 14:30 Ottawa Local Time at Ottawa
  </p>
</div>
</body>
</html>`;

// Appointment page: Colombia, facility 25/26, no checkboxes (real-world pattern)
const APPT_CO_NO_CHECKBOXES = `
<html>
<body>
<form id="appointments_form">
  <input type="hidden" name="authenticity_token" value="abc123token" />
  <div id="consulate_appointment">
    <select id="appointments_consulate_appointment_facility_id" name="appointments[consulate_appointment][facility_id]">
      <option value="25" selected="selected" data-collects-biometrics="false">Bogota</option>
    </select>
    <input type="text" id="appointments_consulate_appointment_date" name="appointments[consulate_appointment][date]" />
    <select id="appointments_consulate_appointment_time">
      <option value="">--</option>
    </select>
  </div>
  <div id="asc_appointment">
    <select id="appointments_asc_appointment_facility_id" name="appointments[asc_appointment][facility_id]">
      <option value="">-- Seleccione --</option>
      <option value="26">Bogota ASC</option>
    </select>
  </div>
</form>
</body>
</html>`;

// Appointment page: Peru, facility 115, no ASC section
const APPT_PE = `
<html>
<body>
<form id="appointments_form">
  <input type="hidden" name="authenticity_token" value="xyz789token" />
  <div id="consulate_appointment">
    <select id="appointments_consulate_appointment_facility_id" name="appointments[consulate_appointment][facility_id]">
      <option value="115" selected="selected">Lima</option>
    </select>
  </div>
</form>
</body>
</html>`;

// Appointment page with checkboxes (theoretical edge case)
const APPT_WITH_CHECKBOXES = `
<html>
<body>
<form id="appointments_form">
  <div class="applicants">
    <input type="checkbox" name="applicants[]" checked="checked" value="10000001" />
    Maria Garcia Lopez
    <br>
    <input type="checkbox" name="applicants[]" checked="checked" value="10000002" />
    Carlos Garcia Ruiz
    <br>
  </div>
  <div id="consulate_appointment">
    <select id="appointments_consulate_appointment_facility_id" name="appointments[consulate_appointment][facility_id]">
      <option value="25" selected="selected">Bogota</option>
    </select>
  </div>
  <div id="asc_appointment">
    <select id="appointments_asc_appointment_facility_id" name="appointments[asc_appointment][facility_id]">
      <option value="">--</option>
      <option value="26">Bogota ASC</option>
    </select>
  </div>
</form>
</body>
</html>`;

// Appointment page with multiple consular facility options
const APPT_MULTI_FACILITY = `
<html>
<body>
<form id="appointments_form">
  <div id="consulate_appointment">
    <select id="appointments_consulate_appointment_facility_id" name="appointments[consulate_appointment][facility_id]">
      <option value="">-- Select --</option>
      <option value="88" selected="selected">Mexico City</option>
      <option value="89">Guadalajara</option>
    </select>
  </div>
  <div id="asc_appointment">
    <select id="appointments_asc_appointment_facility_id" name="appointments[asc_appointment][facility_id]">
      <option value="">-- Select --</option>
      <option value="90">Mexico City ASC</option>
      <option value="91">Guadalajara ASC</option>
    </select>
  </div>
</form>
</body>
</html>`;

// Fixture E: Real-world Colombia, 4 applicants, &#58; entity + &mdash; in appointment text
// Captured from bot 12 (es-co) — structure matches production HTML exactly.
// Key differences from hand-crafted fixtures:
//   - <span>&#58;</span> instead of ":"
//   - &mdash; and <a> link after date text
//   - UPPER CASE names in <td> tags
//   - applicant links nested inside dropdown menus
const GROUPS_E = `
<html>
<body>
<div class="mainContent">
  <table class='medium-12 columns'>
    <thead><tr>
      <th>Nombre del Solicitante</th>
      <th>Pasaporte</th>
      <th class='show-for-medium'>DS-160</th>
      <th class='show-for-medium'>Tipo de Visa</th>
      <th class='show-for-medium'>Estado</th>
    </tr></thead>
    <tbody>
      <tr>
        <td>PEDRO ANTONIO CELEDON REYES</td>
        <td>AT196756</td>
        <td class='show-for-medium'>AA00F10IDJ</td>
        <td class='show-for-medium'>B1/B2 Negocios y turismo (visitante temporal)</td>
        <td class='show-for-medium'><div><a target="_blank" href="https://ceac.state.gov">Verificar</a></div></td>
        <td>
          <ul class='dropdown menu'>
            <li><a href="/es-co/niv/schedule/71075235/applicants/85015928">Detalles</a></li>
            <li><a href="/es-co/niv/schedule/71075235/applicants/85015928/edit">Editar</a></li>
          </ul>
        </td>
      </tr>
      <tr>
        <td>MARIA FERNANDA CABRALES ROSSI</td>
        <td>BA708103</td>
        <td class='show-for-medium'>AA00F10IEE</td>
        <td class='show-for-medium'>B1/B2 Negocios y turismo (visitante temporal)</td>
        <td class='show-for-medium'><div><a target="_blank" href="https://ceac.state.gov">Verificar</a></div></td>
        <td>
          <ul class='dropdown menu'>
            <li><a href="/es-co/niv/schedule/71075235/applicants/85015997">Detalles</a></li>
            <li><a href="/es-co/niv/schedule/71075235/applicants/85015997/edit">Editar</a></li>
          </ul>
        </td>
      </tr>
      <tr>
        <td>PABLO ANDRES CELEDON CABRALES</td>
        <td>CC987654</td>
        <td class='show-for-medium'>AA00F10IFF</td>
        <td class='show-for-medium'>B1/B2 Negocios y turismo (visitante temporal)</td>
        <td class='show-for-medium'><div><a target="_blank" href="https://ceac.state.gov">Verificar</a></div></td>
        <td>
          <ul class='dropdown menu'>
            <li><a href="/es-co/niv/schedule/71075235/applicants/85016085">Detalles</a></li>
            <li><a href="/es-co/niv/schedule/71075235/applicants/85016085/edit">Editar</a></li>
          </ul>
        </td>
      </tr>
      <tr>
        <td>SOFIA VALENTINA CELEDON CABRALES</td>
        <td>DD112233</td>
        <td class='show-for-medium'>AA00F10IGG</td>
        <td class='show-for-medium'>B1/B2 Negocios y turismo (visitante temporal)</td>
        <td class='show-for-medium'><div><a target="_blank" href="https://ceac.state.gov">Verificar</a></div></td>
        <td>
          <ul class='dropdown menu'>
            <li><a href="/es-co/niv/schedule/71075235/applicants/85016161">Detalles</a></li>
            <li><a href="/es-co/niv/schedule/71075235/applicants/85016161/edit">Editar</a></li>
          </ul>
        </td>
      </tr>
    </tbody>
  </table>
  <div class='card'>
    <p class='consular-appt'>
      <strong>Cita Consular<span>&#58;</span></strong>
      12 noviembre, 2026, 09:00 Bogota Hora Local at Bogota
       &mdash;
      <a href="/es-co/niv/schedule/71075235/addresses/consulate"><span class='fas fa-map-marker-alt'></span>
      Cómo llegar
      </a>
    </p>
    <p class='asc-appt'>
      <strong>Cita CAS<span>&#58;</span></strong>
       3 noviembre, 2026, 08:00 BOGOTA Hora Local at Bogota ASC
       &mdash;
      <a href="/es-co/niv/schedule/71075235/addresses/asc"><span class='fas fa-map-marker-alt'></span>
      Cómo llegar
      </a>
    </p>
  </div>
</div>
</body>
</html>`;

// Appointment page: Real-world Colombia, data-collects-biometrics, autocomplete=off
const APPT_CO_REAL = `
<html>
<head>
<meta name="csrf-token" content="BPf4TCyzsFcOGO0OlQ+hwyI/eKAaFP5eDGbC8egtGWidaQ7blsdlcSDoB+YxK53vlElIHmrdWa50/b/VAFqRPw==" />
</head>
<body>
<form id="appointment-form" novalidate="novalidate" class="formtastic appointments" action="/es-co/niv/schedule/71075235/appointment" accept-charset="UTF-8" method="post">
  <input type="hidden" name="authenticity_token" value="vL87bPCISEQxU44o4gooUC7hkwVHzlFkSjqWg5L4VIPqW+6OjTZykC7l1CTS3vb4uSZ+u3DKKtYlC+SeyHTnYg==" autocomplete="off" />
  <input type="hidden" name="confirmed_limit_message" id="confirmed_limit_message" value="1" autocomplete="off" />
  <li class="select input required" id="appointments_consulate_appointment_facility_id_input">
    <select name="appointments[consulate_appointment][facility_id]" id="appointments_consulate_appointment_facility_id" class="required">
      <option value="" label=" "></option>
      <option data-collects-biometrics="false" selected="selected" value="25">Bogota</option>
    </select>
  </li>
  <input type="text" id="appointments_consulate_appointment_date" readonly="readonly" class="required" name="appointments[consulate_appointment][date]" />
  <select name="appointments[consulate_appointment][time]" id="appointments_consulate_appointment_time" class="required">
    <option selected="selected" value=""></option>
  </select>
  <li class="select input required" id="appointments_asc_appointment_facility_id_input">
    <select name="appointments[asc_appointment][facility_id]" id="appointments_asc_appointment_facility_id" class="required">
      <option value="" label=" "></option>
      <option selected="selected" value="26">Bogota ASC</option>
    </select>
  </li>
</form>
</body>
</html>`;

// ── Tests ──────────────────────────────────────────

describe('parseApptDate', () => {
  it('parses Spanish date with time', () => {
    expect(parseApptDate('9 marzo, 2026, 08:15 Bogota Hora Local at Bogota'))
      .toEqual({ date: '2026-03-09', time: '08:15' });
  });

  it('parses English date with time', () => {
    expect(parseApptDate('20 april, 2026, 10:00 Lima Local Time'))
      .toEqual({ date: '2026-04-20', time: '10:00' });
  });

  it('pads single-digit day', () => {
    expect(parseApptDate('5 marzo, 2026, 10:45 BOGOTA'))
      .toEqual({ date: '2026-03-05', time: '10:45' });
  });

  it('handles two-digit day', () => {
    expect(parseApptDate('15 junio, 2026, 07:15'))
      .toEqual({ date: '2026-06-15', time: '07:15' });
  });

  it('handles all 12 Spanish months', () => {
    const months = [
      ['enero', '01'], ['febrero', '02'], ['marzo', '03'], ['abril', '04'],
      ['mayo', '05'], ['junio', '06'], ['julio', '07'], ['agosto', '08'],
      ['septiembre', '09'], ['octubre', '10'], ['noviembre', '11'], ['diciembre', '12'],
    ];
    for (const [name, num] of months) {
      expect(parseApptDate(`1 ${name}, 2026, 09:00`))
        .toEqual({ date: `2026-${num}-01`, time: '09:00' });
    }
  });

  it('handles all 12 English months', () => {
    const months = [
      ['january', '01'], ['february', '02'], ['march', '03'], ['april', '04'],
      ['may', '05'], ['june', '06'], ['july', '07'], ['august', '08'],
      ['september', '09'], ['october', '10'], ['november', '11'], ['december', '12'],
    ];
    for (const [name, num] of months) {
      expect(parseApptDate(`1 ${name}, 2026, 09:00`))
        .toEqual({ date: `2026-${num}-01`, time: '09:00' });
    }
  });

  it('handles extra whitespace around comma', () => {
    expect(parseApptDate('9 marzo,  2026,  08:15'))
      .toEqual({ date: '2026-03-09', time: '08:15' });
  });

  it('parses French date without comma after month', () => {
    // fr-ca portal omits the comma between month and year: "9 mars 2026, 08:15"
    expect(parseApptDate('9 mars 2026, 08:15 Heure locale de Vancouver'))
      .toEqual({ date: '2026-03-09', time: '08:15' });
  });

  it('handles all 12 French months', () => {
    const months = [
      ['janvier', '01'], ['février', '02'], ['mars', '03'], ['avril', '04'],
      ['mai', '05'], ['juin', '06'], ['juillet', '07'], ['août', '08'],
      ['septembre', '09'], ['octobre', '10'], ['novembre', '11'], ['décembre', '12'],
    ];
    for (const [name, num] of months) {
      expect(parseApptDate(`1 ${name} 2026, 09:00`))
        .toEqual({ date: `2026-${num}-01`, time: '09:00' });
    }
  });

  it('handles Portuguese months (Brazil)', () => {
    expect(parseApptDate('15 março, 2026, 10:00')).toEqual({ date: '2026-03-15', time: '10:00' });
    expect(parseApptDate('15 março 2026, 10:00')).toEqual({ date: '2026-03-15', time: '10:00' });
    expect(parseApptDate('1 julho, 2026, 09:00')).toEqual({ date: '2026-07-01', time: '09:00' });
    expect(parseApptDate('20 dezembro, 2026, 14:30')).toEqual({ date: '2026-12-20', time: '14:30' });
  });

  it('handles Italian months', () => {
    expect(parseApptDate('9 marzo, 2026, 08:15')).toEqual({ date: '2026-03-09', time: '08:15' });
    expect(parseApptDate('1 gennaio 2026, 09:00')).toEqual({ date: '2026-01-01', time: '09:00' });
    expect(parseApptDate('20 maggio, 2026, 11:00')).toEqual({ date: '2026-05-20', time: '11:00' });
  });

  it('returns null for unrecognized format', () => {
    expect(parseApptDate('No appointment')).toBeNull();
    expect(parseApptDate('')).toBeNull();
  });

  it('returns null for unknown month name', () => {
    expect(parseApptDate('9 foobar, 2026, 08:15')).toBeNull();
  });
});

describe('detectOverloadError', () => {
  it('detects French overload message', () => {
    expect(detectOverloadError('Le système est surchargé. Veuillez réessayer plus tard.')).toBe(true);
  });

  it('detects English overload message', () => {
    expect(detectOverloadError('The system is overloaded. Please try again later.')).toBe(true);
  });

  it('detects Spanish overload message', () => {
    expect(detectOverloadError('El sistema está sobrecargado.')).toBe(true);
  });

  it('detects Portuguese overload message', () => {
    expect(detectOverloadError('O sistema sobrecarregado, tente mais tarde.')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectOverloadError('SYSTEM IS OVERLOADED')).toBe(true);
  });

  it('returns false on normal page', () => {
    expect(detectOverloadError('<html><body><select>...</select></body></html>')).toBe(false);
  });
});

describe('hasKnownFacilities', () => {
  it('returns true for es-co (Colombia)', () => {
    expect(hasKnownFacilities('es-co')).toBe(true);
  });

  it('returns true for es-pe (Peru)', () => {
    expect(hasKnownFacilities('es-pe')).toBe(true);
  });

  it('returns false for fr-ca (Canada — needs live extraction)', () => {
    expect(hasKnownFacilities('fr-ca')).toBe(false);
  });

  it('returns false for pt-br (Brazil)', () => {
    expect(hasKnownFacilities('pt-br')).toBe(false);
  });
});

describe('extractFacilityIds — guardrail for unknown locales', () => {
  it('throws AppointmentFormMissingError when live page has no consular select (fr-ca)', () => {
    // Warning page returned 200 OK but has no <select> — should NOT silently
    // return empty facility IDs because the locale has no KNOWN_FACILITIES fallback.
    const warningPage = `<html><head><title>Avertissement Limite de Rendez-vous</title></head>
      <body><p>Il vous reste 3 tentative(s) restante(s) avant d'atteindre la limite.</p>
      <input type="checkbox" name="je_comprends"/></body></html>`;
    expect(() => extractFacilityIds(warningPage, true, 'fr-ca'))
      .toThrowError(AppointmentFormMissingError);
  });

  it('marks overload when error message present in missing-form HTML', () => {
    const overloadPage = `<html><body>Le système est surchargé. Veuillez réessayer plus tard.</body></html>`;
    try {
      extractFacilityIds(overloadPage, true, 'fr-ca');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppointmentFormMissingError);
      expect((e as AppointmentFormMissingError).hasOverloadMarker).toBe(true);
    }
  });

  it('does NOT throw for known locales (falls back to KNOWN_FACILITIES)', () => {
    // Same warning page, but es-co has KNOWN_FACILITIES so we tolerate.
    const warningPage = `<html><body>Atención</body></html>`;
    expect(() => extractFacilityIds(warningPage, true, 'es-co')).not.toThrow();
    expect(extractFacilityIds(warningPage, true, 'es-co').consularFacilityId).toBe('25');
  });

  it('successfully extracts consular facility from real fr-ca form (Vancouver=89)', () => {
    const frCaForm = `<html><body>
      <select name="appointments[consulate_appointment][facility_id]" id="appointments_consulate_appointment_facility_id">
        <option value="" label=" "></option>
        <option data-collects-biometrics="false" selected="selected" value="89">Vancouver</option>
      </select>
      <p>Le système est surchargé. Veuillez réessayer plus tard.</p>
    </body></html>`;
    const result = extractFacilityIds(frCaForm, true, 'fr-ca');
    expect(result.consularFacilityId).toBe('89');
    expect(result.ascFacilityId).toBe(''); // Canada has no ASC — legitimate absence
  });
});

describe('extractScheduleId', () => {
  it('extracts from fixture A', () => {
    expect(extractScheduleId(GROUPS_A)).toBe('12345678');
  });

  it('extracts from fixture B', () => {
    expect(extractScheduleId(GROUPS_B)).toBe('87654321');
  });

  it('extracts from fixture C (Peru)', () => {
    expect(extractScheduleId(GROUPS_C)).toBe('55555555');
  });

  it('returns null when no schedule link', () => {
    expect(extractScheduleId('<html><body>No schedule here</body></html>')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractScheduleId('')).toBeNull();
  });
});

describe('extractApplicantIdsFromGroups', () => {
  it('extracts 2 IDs from fixture A (dedup)', () => {
    expect(extractApplicantIdsFromGroups(GROUPS_A)).toEqual(['10000001', '10000002']);
  });

  it('extracts 4 IDs from fixture B', () => {
    expect(extractApplicantIdsFromGroups(GROUPS_B))
      .toEqual(['20000001', '20000002', '20000003', '20000004']);
  });

  it('extracts 1 ID from fixture C (Peru)', () => {
    expect(extractApplicantIdsFromGroups(GROUPS_C)).toEqual(['30000001']);
  });

  it('deduplicates repeated IDs', () => {
    const html = `
      <a href="/applicants/10000001">Edit</a>
      <a href="/applicants/10000001">View</a>
      <a href="/applicants/10000002">Edit</a>
    `;
    expect(extractApplicantIdsFromGroups(html)).toEqual(['10000001', '10000002']);
  });

  it('preserves insertion order', () => {
    const html = `
      <a href="/applicants/30000003">A</a>
      <a href="/applicants/30000001">B</a>
      <a href="/applicants/30000002">C</a>
    `;
    expect(extractApplicantIdsFromGroups(html)).toEqual(['30000003', '30000001', '30000002']);
  });

  it('returns empty for HTML without applicant links', () => {
    expect(extractApplicantIdsFromGroups('<html></html>')).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(extractApplicantIdsFromGroups('')).toEqual([]);
  });
});

describe('extractApplicantIdsFromAppointment', () => {
  it('extracts from checkboxes (name before value)', () => {
    expect(extractApplicantIdsFromAppointment(APPT_WITH_CHECKBOXES))
      .toEqual(['10000001', '10000002']);
  });

  it('extracts from reverse attribute order (value before name)', () => {
    const html = `<input value="99999" type="checkbox" name="applicants[]" />`;
    expect(extractApplicantIdsFromAppointment(html)).toEqual(['99999']);
  });

  it('deduplicates repeated IDs', () => {
    const html = `
      <input name="applicants[]" value="10000001" />
      <input name="applicants[]" value="10000001" />
      <input name="applicants[]" value="10000002" />
    `;
    expect(extractApplicantIdsFromAppointment(html)).toEqual(['10000001', '10000002']);
  });

  it('returns empty when no checkboxes (real-world CO pattern)', () => {
    expect(extractApplicantIdsFromAppointment(APPT_CO_NO_CHECKBOXES)).toEqual([]);
  });

  it('returns empty for Peru page without checkboxes', () => {
    expect(extractApplicantIdsFromAppointment(APPT_PE)).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(extractApplicantIdsFromAppointment('')).toEqual([]);
  });
});

describe('extractApplicantNames', () => {
  describe('from appointment page checkboxes', () => {
    it('extracts names when apptPageOk=true', () => {
      expect(extractApplicantNames('', APPT_WITH_CHECKBOXES, true))
        .toEqual(['Maria Garcia Lopez', 'Carlos Garcia Ruiz']);
    });

    it('prefers checkboxes over groups fallback', () => {
      // Even though groupsHtml has different names, checkbox names should win
      expect(extractApplicantNames(GROUPS_B, APPT_WITH_CHECKBOXES, true))
        .toEqual(['Maria Garcia Lopez', 'Carlos Garcia Ruiz']);
    });
  });

  describe('from groups page <td> fallback', () => {
    it('extracts Title Case names (fixture A)', () => {
      expect(extractApplicantNames(GROUPS_A, APPT_CO_NO_CHECKBOXES, true))
        .toEqual(['Maria Garcia Lopez', 'Carlos Garcia Ruiz']);
    });

    it('extracts when apptPageOk=false', () => {
      expect(extractApplicantNames(GROUPS_A, '', false))
        .toEqual(['Maria Garcia Lopez', 'Carlos Garcia Ruiz']);
    });

    it('normalizes UPPER CASE to Title Case (fixture B)', () => {
      expect(extractApplicantNames(GROUPS_B, APPT_CO_NO_CHECKBOXES, true))
        .toEqual([
          'Pedro Antonio Martinez Silva',
          'Luisa Fernanda Rojas Diaz',
          'Andrés Felipe Gómez López',
          'María José Hernández Ríos',
        ]);
    });

    it('extracts single name from Peru fixture', () => {
      expect(extractApplicantNames(GROUPS_C, APPT_PE, true))
        .toEqual(['Ana Maria Rodriguez Torres']);
    });

    it('handles hyphenated names and apostrophes (fixture D)', () => {
      expect(extractApplicantNames(GROUPS_D, '', false))
        .toEqual(["Jean-pierre O'brien"]);
    });

    it('handles extra whitespace/newlines in <td> content', () => {
      const html = `<table><tr><td>
        PEDRO   MARTINEZ
      </td></tr></table>`;
      expect(extractApplicantNames(html, '', false))
        .toEqual(['Pedro Martinez']);
    });
  });

  describe('filtering', () => {
    it('filters out alphanumeric passport numbers (AB123456)', () => {
      const names = extractApplicantNames(GROUPS_A, '', false);
      expect(names).not.toContain('Ab123456');
      expect(names).not.toContain('AB123456');
    });

    it('filters out numeric passport numbers (123456789)', () => {
      const names = extractApplicantNames(GROUPS_C, '', false);
      expect(names).not.toContain('123456789');
    });

    it('filters out single-word <td> content', () => {
      const html = `<table><tr><td>Editar</td><td>Maria Lopez</td></tr></table>`;
      expect(extractApplicantNames(html, '', false)).toEqual(['Maria Lopez']);
    });

    it('filters out <td> with special characters (links, codes)', () => {
      const html = `<table>
        <tr><td>REF#123</td><td>Maria Lopez</td></tr>
        <tr><td>2026-01-01</td><td>Carlos Ruiz</td></tr>
      </table>`;
      const names = extractApplicantNames(html, '', false);
      expect(names).toEqual(['Maria Lopez', 'Carlos Ruiz']);
    });

    it('returns empty for HTML without names', () => {
      expect(extractApplicantNames('<html></html>', '', false)).toEqual([]);
    });

    it('returns empty for empty strings', () => {
      expect(extractApplicantNames('', '', false)).toEqual([]);
    });
  });
});

describe('extractAppointments', () => {
  it('extracts consular + CAS from fixture A (single-quoted class)', () => {
    expect(extractAppointments(GROUPS_A)).toEqual({
      currentConsularDate: '2026-03-09',
      currentConsularTime: '08:15',
      currentCasDate: '2026-03-05',
      currentCasTime: '10:45',
    });
  });

  it('extracts consular + CAS from fixture B', () => {
    expect(extractAppointments(GROUPS_B)).toEqual({
      currentConsularDate: '2026-06-15',
      currentConsularTime: '07:15',
      currentCasDate: '2026-06-12',
      currentCasTime: '09:30',
    });
  });

  it('extracts consular only from Peru fixture (no CAS)', () => {
    expect(extractAppointments(GROUPS_C)).toEqual({
      currentConsularDate: '2026-04-20',
      currentConsularTime: '10:00',
      currentCasDate: null,
      currentCasTime: null,
    });
  });

  it('extracts from double-quoted class attributes (fixture D)', () => {
    expect(extractAppointments(GROUPS_D)).toEqual({
      currentConsularDate: '2027-01-03',
      currentConsularTime: '14:30',
      currentCasDate: null,
      currentCasTime: null,
    });
  });

  it('returns all nulls for HTML without appointments', () => {
    expect(extractAppointments('<html></html>')).toEqual({
      currentConsularDate: null,
      currentConsularTime: null,
      currentCasDate: null,
      currentCasTime: null,
    });
  });

  it('returns all nulls for empty string', () => {
    expect(extractAppointments('')).toEqual({
      currentConsularDate: null,
      currentConsularTime: null,
      currentCasDate: null,
      currentCasTime: null,
    });
  });
});

// ── Real-world fixture tests (production HTML patterns) ──

describe('real-world: extractAppointments (&#58; entity + &mdash;)', () => {
  it('extracts consular + CAS with <span>&#58;</span> separator', () => {
    expect(extractAppointments(GROUPS_E)).toEqual({
      currentConsularDate: '2026-11-12',
      currentConsularTime: '09:00',
      currentCasDate: '2026-11-03',
      currentCasTime: '08:00',
    });
  });

  it('handles leading space before day number ("  3 noviembre")', () => {
    const result = extractAppointments(GROUPS_E);
    expect(result.currentCasDate).toBe('2026-11-03');
  });
});

describe('real-world: extractScheduleId from nested dropdown links', () => {
  it('extracts scheduleId from applicant action links', () => {
    expect(extractScheduleId(GROUPS_E)).toBe('71075235');
  });
});

describe('real-world: extractApplicantIdsFromGroups with dropdown menus', () => {
  it('extracts 4 unique IDs despite edit/detail duplicates', () => {
    expect(extractApplicantIdsFromGroups(GROUPS_E))
      .toEqual(['85015928', '85015997', '85016085', '85016161']);
  });
});

describe('real-world: extractApplicantNames from 4-applicant table', () => {
  it('extracts and normalizes UPPER CASE names to Title Case', () => {
    expect(extractApplicantNames(GROUPS_E, APPT_CO_REAL, true))
      .toEqual([
        'Pedro Antonio Celedon Reyes',
        'Maria Fernanda Cabrales Rossi',
        'Pablo Andres Celedon Cabrales',
        'Sofia Valentina Celedon Cabrales',
      ]);
  });

  it('filters out passport numbers (AT196756, BA708103, etc.)', () => {
    const names = extractApplicantNames(GROUPS_E, APPT_CO_REAL, true);
    expect(names).not.toContain('At196756');
    expect(names).not.toContain('Ba708103');
    expect(names).not.toContain('Cc987654');
    expect(names).not.toContain('Dd112233');
  });

  it('filters out DS-160 codes (AA00F10IDJ)', () => {
    const names = extractApplicantNames(GROUPS_E, APPT_CO_REAL, true);
    expect(names.some(n => n.includes('AA00'))).toBe(false);
  });

  it('filters out visa type descriptions', () => {
    const names = extractApplicantNames(GROUPS_E, APPT_CO_REAL, true);
    expect(names.some(n => n.includes('Negocios'))).toBe(false);
  });
});

describe('real-world: extractFacilityIds with data-collects-biometrics', () => {
  it('extracts 25/26 from production appointment HTML', () => {
    expect(extractFacilityIds(APPT_CO_REAL, true, 'es-co')).toEqual({
      consularFacilityId: '25',
      ascFacilityId: '26',
    });
  });

  it('skips empty placeholder options (value="" label=" ")', () => {
    const result = extractFacilityIds(APPT_CO_REAL, true, 'es-co');
    expect(result.consularFacilityId).toBe('25');
    expect(result.ascFacilityId).toBe('26');
  });
});

describe('real-world: extractApplicantIdsFromAppointment (no checkboxes)', () => {
  it('returns empty — real Colombia pages have no applicant checkboxes', () => {
    expect(extractApplicantIdsFromAppointment(APPT_CO_REAL)).toEqual([]);
  });
});

describe('extractApplicantVisaTypes', () => {
  it('extracts visa-type label per applicant from real-world Colombia table', () => {
    const labels = extractApplicantVisaTypes(GROUPS_E);
    expect(labels).toHaveLength(4);
    expect(labels[0]).toBe('B1/B2 Negocios y turismo (visitante temporal)');
    expect(labels[3]).toBe('B1/B2 Negocios y turismo (visitante temporal)');
  });

  it('returns empty array when applicant table has no visa-type column', () => {
    const html = `
      <table>
        <tr><td>Pedro</td><td>AT123</td></tr>
        <tr><td>Maria</td><td>AT456</td></tr>
      </table>
    `;
    expect(extractApplicantVisaTypes(html)).toEqual([]);
  });

  it('handles mixed visa types in same group', () => {
    const html = `
      <thead><tr><th>Nombre</th><th>Pasaporte</th><th class='show-for-medium'>DS-160</th><th class='show-for-medium'>Tipo de Visa</th></tr></thead>
      <tbody>
        <tr><td>A</td><td>1</td><td class='show-for-medium'>AA1</td><td class='show-for-medium'>B1/B2 Negocios y turismo</td></tr>
        <tr><td>B</td><td>2</td><td class='show-for-medium'>AA2</td><td class='show-for-medium'>F1 Estudiante</td></tr>
        <tr><td>C</td><td>3</td><td class='show-for-medium'>AA3</td><td class='show-for-medium'>F2 Cónyuge o hijo de F1</td></tr>
      </tbody>`;
    expect(extractApplicantVisaTypes(html)).toEqual([
      'B1/B2 Negocios y turismo',
      'F1 Estudiante',
      'F2 Cónyuge o hijo de F1',
    ]);
  });

  it('skips thead rows', () => {
    const html = `
      <thead><tr><th>X</th><th class='show-for-medium'>DS-160</th><th class='show-for-medium'>Tipo de Visa</th></tr></thead>
      <tbody><tr><td>A</td><td class='show-for-medium'>X</td><td class='show-for-medium'>J1 Visitante de intercambio</td></tr></tbody>
    `;
    expect(extractApplicantVisaTypes(html)).toEqual(['J1 Visitante de intercambio']);
  });

  it('handles double-quoted class attribute', () => {
    const html = `
      <tr><td>A</td><td class="show-for-medium">AA1</td><td class="show-for-medium">B2 Turismo</td></tr>
    `;
    expect(extractApplicantVisaTypes(html)).toEqual(['B2 Turismo']);
  });
});

describe('normalizeVisaCategory', () => {
  it('extracts B1/B2 from full Spanish label', () => {
    expect(normalizeVisaCategory('B1/B2 Negocios y turismo (visitante temporal)')).toBe('B1/B2');
  });

  it('extracts F1', () => {
    expect(normalizeVisaCategory('F1 Estudiante')).toBe('F1');
  });

  it('extracts J1 with parenthetical detail', () => {
    expect(normalizeVisaCategory('J1 Visitante profesional de intercambio (ej. Médico,académico)'))
      .toBe('J1');
  });

  it('strips hyphens (B-1 → B1, F-1 → F1)', () => {
    expect(normalizeVisaCategory('B-1 Business visitor')).toBe('B1');
    expect(normalizeVisaCategory('F-1 Student')).toBe('F1');
  });

  it('handles C1/D combined code', () => {
    expect(normalizeVisaCategory('C1/D Tripulante en tránsito')).toBe('C1/D');
  });

  it('handles letter-only codes (TN, TD, I)', () => {
    expect(normalizeVisaCategory('TN Profesional del NAFTA')).toBe('TN');
    expect(normalizeVisaCategory('TD Cónyuge o hijo de TN')).toBe('TD');
    expect(normalizeVisaCategory('I Representante de medios extranjeros')).toBe('I');
  });

  it('handles longer codes (T1, T5/T6, U1)', () => {
    expect(normalizeVisaCategory('T1 Víctima de la trata')).toBe('T1');
    expect(normalizeVisaCategory('T5/T6 Hermana de un T1 / Beneficiario derivado')).toBe('T5/T6');
    expect(normalizeVisaCategory('U1 Víctima de un delito')).toBe('U1');
  });

  it('returns null for unparseable label', () => {
    expect(normalizeVisaCategory('')).toBeNull();
    expect(normalizeVisaCategory(null)).toBeNull();
    expect(normalizeVisaCategory(undefined)).toBeNull();
    expect(normalizeVisaCategory('123 not a visa')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeVisaCategory('  B1/B2 Negocios  ')).toBe('B1/B2');
  });
});

describe('pickPrimaryVisaCategory', () => {
  it('returns the only category when all applicants share', () => {
    expect(pickPrimaryVisaCategory([
      'B1/B2 Negocios y turismo',
      'B1/B2 Negocios y turismo',
      'B1/B2 Negocios y turismo',
    ])).toBe('B1/B2');
  });

  it('returns the most common in mixed groups', () => {
    expect(pickPrimaryVisaCategory([
      'B1/B2 Negocios y turismo',
      'F1 Estudiante',
      'F1 Estudiante',
    ])).toBe('F1');
  });

  it('breaks ties by first occurrence', () => {
    expect(pickPrimaryVisaCategory([
      'F1 Estudiante',
      'B1/B2 Negocios',
    ])).toBe('F1');
  });

  it('returns null for empty input', () => {
    expect(pickPrimaryVisaCategory([])).toBeNull();
  });

  it('returns null when no labels are parseable', () => {
    expect(pickPrimaryVisaCategory(['(empty)', '???'])).toBeNull();
  });
});

describe('extractGroups: visa-type integration', () => {
  it('populates applicantVisaTypes and primaryVisaCategory from real-world Colombia HTML', () => {
    const groups = extractGroups(GROUPS_E);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.applicantVisaTypes).toHaveLength(4);
    expect(groups[0]!.primaryVisaCategory).toBe('B1/B2');
  });

  it('returns empty visa-type fields when column missing', () => {
    const html = `
      <table>
        <tr><td><a href="/es-co/niv/schedule/12345/applicants/100">Editar</a></td><td>Pedro X</td><td>AT1</td></tr>
      </table>
    `;
    const groups = extractGroups(html);
    expect(groups[0]?.applicantVisaTypes).toEqual([]);
    expect(groups[0]?.primaryVisaCategory).toBeNull();
  });
});

// Fixture F: Two groups where the first /schedule/{id}/ occurrence is a "Continuar" button
// that appears BEFORE the applicant <table>. This is the real AIS Colombia structure.
// Group 1: 3 applicants, no date. Group 2: 2 applicants, Feb 3 2027.
// Bug: without the fix, the backwards <table> search for Group 2 finds Group 1's table
// (which starts after Group 1's first schedule link = prevBoundary), causing Group 2 to
// incorrectly show 5 applicants and "Juan Carlos" as its first name.
const GROUPS_F = `
<html><body>
<ul class='dropdown-menu align-right actions'>
  <li><a href="/es-co/niv/schedule/74396272/continue_actions">Continuar</a></li>
</ul>
<div class='card'>
  <table>
    <tr><td>Juan Carlos Mendivil Acosta</td><td>BA100001</td><td>B1/B2 Negocios y turismo (visitante temporal)</td></tr>
    <tr><td>Liliana Patricia Marenco Lopez</td><td>BA100002</td><td>B1/B2 Negocios y turismo (visitante temporal)</td></tr>
    <tr><td>Julian David Mendivil Marenco</td><td>BA100003</td><td>B1/B2 Negocios y turismo (visitante temporal)</td></tr>
    <tr>
      <td><a href="/es-co/niv/schedule/74396272/applicants/11000001">Editar</a></td>
      <td><a href="/es-co/niv/schedule/74396272/applicants/11000002">Editar</a></td>
      <td><a href="/es-co/niv/schedule/74396272/applicants/11000003">Editar</a></td>
    </tr>
  </table>
</div>
<ul class='dropdown-menu align-right actions'>
  <li><a href="/es-co/niv/schedule/71321952/continue_actions">Continuar</a></li>
</ul>
<div class='card'>
  <table>
    <tr><td>Juan Camilo Mendivil Marenco</td><td>BA225482</td><td>B1/B2 Negocios y turismo (visitante temporal)</td></tr>
    <tr><td>Diego Alejandro Mendivil Marenco</td><td>AV441012</td><td>B1/B2 Negocios y turismo (visitante temporal)</td></tr>
    <tr>
      <td><a href="/es-co/niv/schedule/71321952/applicants/85307072">Editar</a></td>
      <td><a href="/es-co/niv/schedule/71321952/applicants/85307146">Editar</a></td>
    </tr>
  </table>
  <p class='consular-appt'>
    <strong>Cita Consular:</strong>
    3 febrero, 2027, 07:15 Bogota Hora Local at Bogota
  </p>
  <p class='asc-appt'>
    <strong>Cita ASC:</strong>
    29 enero, 2027, 14:00 BOGOTA Hora Local at Bogota ASC
  </p>
</div>
</body></html>`;

describe('extractGroups: Continuar-button-before-table (two-group bleed fix)', () => {
  it('isolates groups correctly when schedule ID first appears in a Continuar button before the table', () => {
    const groups = extractGroups(GROUPS_F);
    expect(groups).toHaveLength(2);
  });

  it('group 1 (74396272) has exactly 3 applicants', () => {
    const groups = extractGroups(GROUPS_F);
    expect(groups[0]!.scheduleId).toBe('74396272');
    expect(groups[0]!.applicantIds).toHaveLength(3);
    expect(groups[0]!.applicantIds).toEqual(['11000001', '11000002', '11000003']);
  });

  it('group 1 names are Juan Carlos, Liliana, Julian — not contaminated by group 2', () => {
    const groups = extractGroups(GROUPS_F);
    expect(groups[0]!.applicantNames).toEqual([
      'Juan Carlos Mendivil Acosta',
      'Liliana Patricia Marenco Lopez',
      'Julian David Mendivil Marenco',
    ]);
  });

  it('group 2 (71321952) has exactly 2 applicants — not 5 from bleed', () => {
    const groups = extractGroups(GROUPS_F);
    expect(groups[1]!.scheduleId).toBe('71321952');
    expect(groups[1]!.applicantIds).toHaveLength(2);
    expect(groups[1]!.applicantIds).toEqual(['85307072', '85307146']);
  });

  it('group 2 first name is Juan Camilo — not Juan Carlos from group 1', () => {
    const groups = extractGroups(GROUPS_F);
    expect(groups[1]!.applicantNames[0]).toBe('Juan Camilo Mendivil Marenco');
    expect(groups[1]!.applicantNames).toEqual([
      'Juan Camilo Mendivil Marenco',
      'Diego Alejandro Mendivil Marenco',
    ]);
  });

  it('group 2 has the correct consular date and no date on group 1', () => {
    const groups = extractGroups(GROUPS_F);
    expect(groups[0]!.currentConsularDate).toBeNull();
    expect(groups[1]!.currentConsularDate).toBe('2027-02-03');
    expect(groups[1]!.currentCasDate).toBe('2027-01-29');
  });
});

describe('extractVisaClassFromEditPage', () => {
  // Realistic snippet from /schedule/{id}/applicants/{id}/edit (truncated for the test).
  const EDIT_B1B2 = `
    <form>
      <select disabled="disabled" data-petitioner-help-values="[]" class="select required hasHelp" tabindex="8" required="required" aria-required="true" name="applicant[visa_class_id]" id="applicant_visa_class_id">
        <option value="" label=" "></option>
        <option value="1">B1 Negocios / Conferencia / Empleada domestica</option>
        <option selected="selected" value="2">B1/B2 Negocios y turismo (visitante temporal)</option>
        <option value="3">B2 Turismo / Tratamiento Médico </option>
        <option value="11">F1 Estudiante</option>
        <option value="22">J1 Visitante de intercambio de trabajo (ej. Profesor, interno, trabajador de verano)</option>
        <option value="49">Profesional del NAFTA con visa TN</option>
      </select>
      <select name="applicant[previous_visa_class_id]"><option selected="selected" value="0">N/A</option></select>
    </form>`;

  const EDIT_F1 = `
    <select name="applicant[visa_class_id]" id="applicant_visa_class_id">
      <option value="" label=" "></option>
      <option value="2">B1/B2 Negocios y turismo (visitante temporal)</option>
      <option value="11" selected="selected">F1 Estudiante</option>
    </select>`;

  it('extracts canonical visa_class_id and label', () => {
    expect(extractVisaClassFromEditPage(EDIT_B1B2)).toEqual({
      classId: 2,
      label: 'B1/B2 Negocios y turismo (visitante temporal)',
    });
  });

  it('handles reverse attribute order (value before selected)', () => {
    expect(extractVisaClassFromEditPage(EDIT_F1)).toEqual({
      classId: 11,
      label: 'F1 Estudiante',
    });
  });

  it('ignores previous_visa_class_id select', () => {
    const html = `
      <select name="applicant[previous_visa_class_id]"><option selected="selected" value="99">Old</option></select>
      <select name="applicant[visa_class_id]"><option selected="selected" value="3">B2 Turismo</option></select>
    `;
    expect(extractVisaClassFromEditPage(html)).toEqual({ classId: 3, label: 'B2 Turismo' });
  });

  it('returns null when no option is selected', () => {
    const html = `
      <select name="applicant[visa_class_id]">
        <option value="1">B1</option>
        <option value="2">B1/B2</option>
      </select>`;
    expect(extractVisaClassFromEditPage(html)).toBeNull();
  });

  it('returns null when select is missing', () => {
    expect(extractVisaClassFromEditPage('<html></html>')).toBeNull();
  });
});

describe('extractFacilityIds', () => {
  it('extracts 25/26 from Colombia appointment page', () => {
    expect(extractFacilityIds(APPT_CO_NO_CHECKBOXES, true, 'es-co')).toEqual({
      consularFacilityId: '25',
      ascFacilityId: '26',
    });
  });

  it('extracts 115/empty from Peru appointment page', () => {
    expect(extractFacilityIds(APPT_PE, true, 'es-pe')).toEqual({
      consularFacilityId: '115',
      ascFacilityId: '',
    });
  });

  it('extracts from appointment page with checkboxes', () => {
    expect(extractFacilityIds(APPT_WITH_CHECKBOXES, true, 'es-co')).toEqual({
      consularFacilityId: '25',
      ascFacilityId: '26',
    });
  });

  it('extracts correct facility with multiple options (picks first numeric)', () => {
    expect(extractFacilityIds(APPT_MULTI_FACILITY, true, 'es-mx')).toEqual({
      consularFacilityId: '88',
      ascFacilityId: '90',
    });
  });

  it('skips placeholder options with empty value', () => {
    // The multi-facility fixture has <option value="">-- Select --</option> first
    // Should skip it and pick value="88"
    const result = extractFacilityIds(APPT_MULTI_FACILITY, true, 'es-mx');
    expect(result.consularFacilityId).toBe('88');
    expect(result.ascFacilityId).toBe('90');
  });

  describe('fallback to known facilities', () => {
    it('es-co when apptPageOk=false', () => {
      expect(extractFacilityIds('', false, 'es-co')).toEqual({
        consularFacilityId: '25',
        ascFacilityId: '26',
      });
    });

    it('es-pe when apptPageOk=false', () => {
      expect(extractFacilityIds('', false, 'es-pe')).toEqual({
        consularFacilityId: '115',
        ascFacilityId: '',
      });
    });

    it('returns empty strings for unknown locale with no appt page', () => {
      expect(extractFacilityIds('', false, 'en-xx')).toEqual({
        consularFacilityId: '',
        ascFacilityId: '',
      });
    });

    it('falls back when appt HTML has no facility selects', () => {
      const html = '<form><input name="authenticity_token" value="x"/></form>';
      expect(extractFacilityIds(html, true, 'es-co')).toEqual({
        consularFacilityId: '25',
        ascFacilityId: '26',
      });
    });
  });
});
