import { describe, it, expect } from 'vitest';
import {
  parseApptDate,
  extractScheduleId,
  extractApplicantIdsFromGroups,
  extractApplicantIdsFromAppointment,
  extractApplicantNames,
  extractAppointments,
  extractFacilityIds,
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

  it('returns null for unrecognized format', () => {
    expect(parseApptDate('No appointment')).toBeNull();
    expect(parseApptDate('')).toBeNull();
  });

  it('returns null for unknown month name', () => {
    expect(parseApptDate('9 foobar, 2026, 08:15')).toBeNull();
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
