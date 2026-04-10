# /watch-fix — Monitor + auto-fix post-deploy

Monitorea bots después de un cambio importante y aplica fixes automáticamente si detecta problemas.

**Uso:** `/watch-fix <duration> <botId|bot_ids>`
**Ejemplos:** `/watch-fix 30m 7`, `/watch-fix 1h 6`, `/watch-fix 45m 16 17 18`, `/watch-fix 60m bots colombianos activos (16, 17, 18) — revisa rotacion de IPs webshare`

---

## Instrucciones

El usuario quiere monitorear: `$ARGUMENTS`

Parsea el argumento para extraer:
- `duration` (ej: `30m`, `1h`)
- `botIds` — lista de IDs de bots (ej: `7`, `6 12`, `16 17 18`). Si el argumento tiene descripción libre, extrae los números que parezcan IDs de bots.

### Setup inicial

1. Convierte la duración a minutos. Calcula el intervalo entre ciclos:
   - ≤15m → intervalo 2m
   - 16–45m → intervalo 5m
   - 46m–2h → intervalo 10m
   - >2h → intervalo 15m
   - **Excepción: el primer ciclo siempre se corre a los 2 minutos**.
2. Muestra un header de inicio:
   ```
   === /watch-fix: bots {botIds} por {duration} ===
   Inicio: {hora Bogota} | Fin estimado: {hora+duration Bogota}
   Intervalo: {N}m | Total iteraciones: {M}
   ```

### Ciclo de monitoreo (repetir hasta agotar la duración)

En cada iteración ejecuta el script de monitoreo y reporta los resultados:

```bash
source .env && python3 scripts/watchfix-check.py {botIds...}
```

El script reporta por cada bot:
- **status** (active/error/login_required/paused), consecutiveErrors, activeRunId corto, fecha cita
- **poll rate** (p/min), últimos 5 statuses, IPs en uso (last 15), connInfo coverage
- **chain health** — basado en freshness del último poll: <3min=OK, 3-35min=backoff?, >35min=MUERTA
- **TCP blocks** count en últimos 10 polls
- **IP overlap** cross-bot

El script imprime alertas al final. Úsalas para disparar fixes:

### Fixes automáticos

| Alerta del script | Fix automático |
|----------|---------------|
| `LOGIN_REQUIRED` | `mcp__trigger__trigger_task(taskId="login-visa", environment="prod", payload={botId, chainId:"dev"})` → espera 5s → verifica con `get_run_details` |
| `CHAIN_DEAD` | `curl -s -X POST https://visa.homiapp.xyz/api/bots/{botId}/resume` |
| `STATUS_ERROR` | Leer journalctl: `source .env && sshpass -p "$RPI_PASS" ssh rpi "journalctl -u visa-trigger --since '5 min ago' --no-pager | tail -20"` → identificar causa |
| `HIGH_ERRORS` (consecutiveErrors ≥ 3) | Revisar últimos poll logs, identificar patrón |
| `TCP_SUSTAINED` (≥5/10 bloqueados) | Solo reportar — backoffs automáticos están en el código |
| connInfo=0/15 con proxy=webshare | Revisar poll-visa.ts race condition fix, deploy si es necesario |

**Regla**: Aplicar el fix **sin preguntar** y reportar lo que se hizo.

### Formato de reporte por iteración

```
─── Iter {N}/{total} — {hora Bogota} ───────────────────────
[output del script aquí — resumido si no hay alertas]

{si hay alertas/fixes:}
[ALERTA] Bot {id}: {kind} — {msg}
[FIX] {descripción del problema} → {acción tomada} → {resultado}
```

### Al finalizar

Muestra un resumen:
```
=== Resumen /watch-fix: bots {botIds} ({duration}) ===
Iteraciones  : {N}
Fixes hechos : {lista o "ninguno"}
Estado final : {status por bot}
Última cita  : {currentConsularDate por bot}
IP overlap   : {ok o IPs compartidas}
```

---

## Reglas importantes

- **NUNCA** reagendar manualmente (no `--commit`, no `client.reschedule()`).
- Reportar horas en **Bogota (UTC-5)**.
- Si el fix de login-visa falla 2 veces seguidas → reportar y detener intentos de re-login.
- Si el deploy:rpi falla → reportar el error, no reintentar automáticamente.
- TCP blocks: solo reportar, no intervenir (los backoffs están en el código).
- Usar `jq` siempre con **comillas simples**: `jq '...'` nunca `jq "..."`.
- **Trigger.dev MCP**: usar solo para fix de login-visa. NO usar para chain health (el script ya lo cubre).
