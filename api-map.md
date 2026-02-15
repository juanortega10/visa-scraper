# API Map - US Visa Appointment System (ais.usvisa-info.com)

## Base URL
`https://ais.usvisa-info.com/es-co/niv`

## Authentication
- **Login:** `POST /users/sign_in` (form POST, not API)
  - Fields: `user[email]`, `user[password]`, `policy_agreed=1`, `commit=Iniciar sesión`
  - CSRF token from `meta[name="csrf-token"]` sent as `authenticity_token`
  - hCaptcha present but auto-passes with human-like behavior
  - Session cookie is **HttpOnly** (not accessible via JS)
  - Response: redirect to `/groups/{userId}`

- **Logout:** `GET /users/sign_out`

## Facility IDs
| Facility | ID | Type |
|----------|-----|------|
| Bogota (Consular) | `25` | Consulate |
| Bogota ASC | `26` | CAS |

## Endpoints

### 1. Available Days (Consular)
```
GET /schedule/{scheduleId}/appointment/days/{facilityId}.json?appointments[expedite]=false
```
**Example:**
```
GET /schedule/{SCHEDULE_ID}/appointment/days/25.json?appointments[expedite]=false
```
**Response:** `200 OK` — `application/json`
```json
[
  {"date": "2026-12-22", "business_day": true},
  {"date": "2026-12-28", "business_day": true},
  {"date": "2027-01-12", "business_day": true}
  // ... more dates
]
```

**Response Headers (notable):**
- `session-id: {random_session_id}`
- `x-yatri-email: {user_email}`
- `x-yatri-country: co`
- `x-yatri-language: es`
- `x-yatri-roles: self_service`
- `cache-control: max-age=0, private, must-revalidate`

### 2. Available Days (CAS)
```
GET /schedule/{scheduleId}/appointment/days/{ascFacilityId}.json?consulate_id={consulateFacilityId}&consulate_date={YYYY-MM-DD}&consulate_time={HH:MM}&appointments[expedite]=false
```
**Example:**
```
GET /schedule/{SCHEDULE_ID}/appointment/days/26.json?consulate_id=25&consulate_date=2026-12-22&consulate_time=&appointments[expedite]=false
```
**Response:** Same format as consular days (array of date objects). Note: CAS dates depend on selected consulate date.

### 3. Available Times
```
GET /schedule/{scheduleId}/appointment/times/{facilityId}.json?date={YYYY-MM-DD}&appointments[expedite]=false
```
**Example:**
```
GET /schedule/{SCHEDULE_ID}/appointment/times/25.json?date=2026-12-22&appointments[expedite]=false
```
**Response:** `200 OK`
```json
{
  "available_times": ["07:30", "07:45", "08:15", "08:30"],
  "business_times": ["07:30", "07:45", "08:15", "08:30"]
}
```

### 4. Facility Address
```
GET /schedule/{scheduleId}/appointment/address/{facilityId}
```
**Response:** HTML fragment with address info.

### 5. Reschedule (Submit)
```
POST /schedule/{scheduleId}/appointment
```
**Form fields:**
- `authenticity_token` — from hidden input in form
- `confirmed_limit_message` = `1`
- `use_consulate_appointment_capacity` = `true`
- `appointments[consulate_appointment][facility_id]` = `25`
- `appointments[consulate_appointment][date]` = `YYYY-MM-DD`
- `appointments[consulate_appointment][time]` = `HH:MM`
- `appointments[asc_appointment][facility_id]` = `26`
- `appointments[asc_appointment][date]` = `YYYY-MM-DD`
- `appointments[asc_appointment][time]` = `HH:MM`
- `commit` = `Reprogramar`

**Note:** This is a form POST (not JSON API). Requires `authenticity_token` from the page.

**Confirmation flow:**
1. Click "Reprogramar" button → JS modal appears: "¿Desea reprogramar esta cita?"
2. Click "Confirmar" in modal → triggers actual form POST
3. Server returns **302 redirect** → `/schedule/{scheduleId}/appointment/instructions`
4. Instructions page shows: "Usted ha programado exitosamente su cita de visa"
5. Premium delivery upsell modal appears (dismiss with "No gracias")

**For API-only approach:** POST directly with form data, follow 302 redirect. Success = redirect to instructions page.

## Navigation Flow
1. `GET /` → Home
2. `GET /users/sign_in` → Login page
3. `POST /users/sign_in` → Login (form POST, redirects to groups)
4. `GET /groups/{userId}` → Dashboard
5. `GET /schedule/{scheduleId}/continue_actions` → Actions menu
6. `GET /schedule/{scheduleId}/appointment` → Applicant selection (checkboxes)
7. `GET /schedule/{scheduleId}/appointment?applicants[]={id1}&applicants[]={id2}&confirmed_limit_message=1&commit=Continuar` → Date picker page
8. XHR: `GET .../days/25.json` → Available consular dates
9. XHR: `GET .../times/25.json?date=...` → Available consular times
10. User selects consular date+time → CAS section activates
11. XHR: `GET .../days/26.json?consulate_id=25&consulate_date={date}&consulate_time={time}` → Available CAS dates (BEFORE consular date)
12. XHR: `GET .../times/26.json?date=...` → Available CAS times
13. Both sections filled → "Reprogramar" button enables
14. `POST /schedule/{scheduleId}/appointment` → Submit reschedule

## Scheduling Rules
- CAS appointment must be **BEFORE** consular appointment
- CAS dates depend on selected consular date+time
- CAS has many more time slots (28) vs consular (4)
- Both appointments are required to submit

## Dynamic Data
- **Applicant IDs** — get from checkboxes: `input[name="applicants[]"]` on step 6
- **Facility IDs** — get from select options on step 7
- **CSRF token** — get from `meta[name="csrf-token"]` or hidden `authenticity_token` input
- **Schedule ID** — from URL pattern on dashboard (link to `continue_actions`)

## Request Headers

### For JSON API calls (days/times)
```
Accept: application/json
X-Requested-With: XMLHttpRequest
Cookie: _yatri_session=<session_value>
```

### For Reschedule POST
```
Content-Type: application/x-www-form-urlencoded
Origin: https://ais.usvisa-info.com
Referer: https://ais.usvisa-info.com/es-co/niv/schedule/{scheduleId}/appointment?applicants[]=...
Cookie: _yatri_session=<session_value>
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36
```

## Session Cookie
- **Name:** `_yatri_session`
- **HttpOnly:** yes (not accessible via JS)
- **Obtained:** Set by server after POST to `/users/sign_in`
- **Format:** URL-encoded encrypted Rails session
- **Duration:** TODO - needs investigation

## Rate Limiting / Notes
- CAS days endpoint returned 502 on repeated calls (possible rate limiting)
- CSRF token rotates per page load
- No explicit `X-CSRF-Token` header required for GET JSON endpoints
- `authenticity_token` required for form POST submissions (from hidden input on page)
- Reschedule POST returns 302 → `/appointment/instructions` on success

## Current Available Dates (captured 2026-02-09)
First available consular: **2026-12-22** (same as current appointment)
Next: 2026-12-28, 2026-12-29, then Jan 2027+
