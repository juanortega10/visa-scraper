import { describe, it, expect } from 'vitest';
import { extractGroups, isSchedulableGroup } from '../html-parsers.js';

/**
 * Trimmed from the live /groups/33996245 page of bot 285 (2026-08-12).
 * Three cards, three portal states:
 *   75299447 attend_appointment — real appointment 2026-12-29
 *   47093486 appointment        — past appointment 2024-07-10, label rendered in ENGLISH
 *                                 on an es-co page (never branch on the visible text)
 *   64978001 needs_payment      — visa fee unpaid, no consulate/ASC address, no date
 */
const GROUPS_UNPAID = `
<div class='application attend_appointment card success'>
<div class='row'><div class='medium-6 columns'><h4 class='status'>
<small>Estado actual</small>
<br>
Cita Asistir
</br></h4></div></div>
<table><tbody>
<tr><td>CARMEN YANETH BRAN JARAMILLO</td><td>AU429832</td>
<td class='show-for-medium'>AA00BQRAY3</td>
<td class='show-for-medium'>B1/B2 Negocios y turismo (visitante temporal)</td>
<td><a href="/es-co/niv/schedule/75299447/applicants/90153271"></a></td></tr>
</tbody></table>
<p class='consular-appt'><strong>Cita consular</strong>
29 diciembre, 2026, 08:15 Bogota</p>
<p class='asc-appt'><strong>Cita CAS</strong>
21 diciembre, 2026, 07:00 Bogota</p>
<a href="/es-co/niv/schedule/75299447/addresses/consulate">consulado</a>
</div>

<div class='application appointment card secondary'>
<div class='row'><div class='medium-6 columns'><h4 class='status'>
<small>Estado actual</small>
<br>
Appointment
</br></h4></div></div>
<table><tbody>
<tr><td>JAMES OLVANY MURILLO ECHEVERRY</td><td>AT123456</td>
<td class='show-for-medium'>AA00AAAAA1</td>
<td class='show-for-medium'>B1/B2 Negocios y turismo (visitante temporal)</td>
<td><a href="/es-co/niv/schedule/47093486/applicants/54834314"></a></td></tr>
</tbody></table>
<p class='consular-appt'><strong>Cita consular</strong>
10 julio, 2024, 07:30 Bogota</p>
</div>

<div class='alert application card needs_payment'>
<div class='row'><div class='medium-6 columns'><h4 class='status'>
<small>Estado actual</small>
<br>
Pago de arancel de visa
</br></h4></div>
<div class='medium-6 columns text-right'><ul class='dropdown menu align-right actions'>
<li><a class="button primary small" href="/es-co/niv/schedule/64978001/continue_actions">Continuar</a></li>
</ul></div></div>
<div class='card'><p class='delivery'><strong>Ubicación de entrega de documentos</strong>
FedEx ENVIGADO &ndash; MEDELLIN, CO &mdash;
<a href="/es-co/niv/schedule/64978001/addresses/delivery">Ver mapa</a></p></div>
<table><tbody>
<tr><td>CARMEN YANETH BRAN JARAMILLO</td><td>AU429832</td>
<td class='show-for-medium'>AA00BQRAY3</td>
<td class='show-for-medium'>B1/B2 Negocios y turismo (visitante temporal)</td>
<td><a href="/es-co/niv/schedule/64978001/applicants/54834001"></a></td></tr>
</tbody></table>
</div>
`;

describe('extractGroups: portal state per card', () => {
  const groups = extractGroups(GROUPS_UNPAID);

  it('finds all three schedules', () => {
    expect(groups.map((g) => g.scheduleId)).toEqual(['75299447', '47093486', '64978001']);
  });

  it('reads the state token from the card class, not the visible text', () => {
    expect(groups.map((g) => g.status.token)).toEqual([
      'attend_appointment',
      'appointment',
      'needs_payment',
    ]);
  });

  it('keeps the visible label for support, including the untranslated one', () => {
    expect(groups.map((g) => g.status.text)).toEqual([
      'Cita Asistir',
      'Appointment',
      'Pago de arancel de visa',
    ]);
  });

  it('does not leak layout classes into the state token', () => {
    for (const g of groups) {
      expect(['card', 'application', 'alert', 'success', 'secondary']).not.toContain(g.status.token);
    }
  });

  it('parses no appointment for the unpaid group', () => {
    const unpaid = groups.find((g) => g.scheduleId === '64978001')!;
    expect(unpaid.currentConsularDate).toBeNull();
    expect(unpaid.currentCasDate).toBeNull();
  });

  it('still parses the real appointment on the paid group', () => {
    const paid = groups.find((g) => g.scheduleId === '75299447')!;
    expect(paid.currentConsularDate).toBe('2026-12-29');
    expect(paid.currentConsularTime).toBe('08:15');
    expect(paid.currentCasDate).toBe('2026-12-21');
  });
});

describe('isSchedulableGroup', () => {
  const groups = extractGroups(GROUPS_UNPAID);

  it('rejects the unpaid-fee group', () => {
    expect(isSchedulableGroup(groups.find((g) => g.scheduleId === '64978001')!)).toBe(false);
  });

  it('accepts a group with an upcoming appointment', () => {
    expect(isSchedulableGroup(groups.find((g) => g.scheduleId === '75299447')!)).toBe(true);
  });

  it('accepts a group whose appointment already passed', () => {
    // A past date is a separate problem (the bot needs a strictly earlier slot). It is
    // not an unpaid fee, so state parsing must not lump the two together.
    expect(isSchedulableGroup(groups.find((g) => g.scheduleId === '47093486')!)).toBe(true);
  });

  it('stays permissive when the page has no card markup', () => {
    expect(isSchedulableGroup({ status: { token: null, text: null } })).toBe(true);
  });

  it('stays permissive on an unknown portal state', () => {
    // Deny-list by design: a state we have never seen must not silently drop a client.
    expect(isSchedulableGroup({ status: { token: 'ds160_review', text: 'Revisión' } })).toBe(true);
  });
});

describe('extractGroups: pages without card markup', () => {
  it('returns a null status instead of throwing', () => {
    const bare = `
      <table><tbody><tr><td>Juan Alberto Ortega</td><td>AB123456</td></tr></tbody></table>
      <a href="/es-co/niv/schedule/72824354/applicants/87117943"></a>
      <p class='consular-appt'><strong>Cita consular</strong>
      1 abril, 2026, 07:45 Bogota</p>
    `;
    const groups = extractGroups(bare);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.status).toEqual({ token: null, text: null });
    expect(groups[0]!.currentConsularDate).toBe('2026-04-01');
  });
});
