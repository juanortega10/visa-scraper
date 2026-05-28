# bot-140-141-sniper

Gestiona el dual sniper de bots 140+141 (alineación familiar de citas visa).

## Objetivo

Lograr que ambos bots tengan:
1. CAS ∈ [2026-05-19, 2026-05-22] (Martes-Viernes mayo 2026)
2. Misma fecha consular
3. Hora consular con ≤15 min de diferencia

## Estado actual (última vez activo: 2026-05-17)

- **Bot 140**: consular 2027-02-11 09:45 | CAS 2027-02-03 — schedule 64535371 (3 aplicantes), bloqueado por embajada ~48h+
- **Bot 141**: consular 2026-05-27 07:00 | CAS 2026-05-19 ✅ — schedule 74307951 (2 aplicantes), funcionando bien

## Comandos

### Verificar estado actual
```bash
source .env && sshpass -p "$RPI_PASS" ssh rpi "ps -eo pid,command --no-headers | grep -E 'tsx.*dual-sniper' | grep -v grep; tail -15 /home/agetrox/visa-scraper/logs/dual-sniper.log"
```

### Verificar fechas en DB
Escribir y ejecutar en RPi:
```typescript
// scripts/_check-bots-tmp.ts
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { inArray } from 'drizzle-orm';
const rows = await db.select({ id: bots.id, consular: bots.currentConsularDate, consularTime: bots.currentConsularTime, cas: bots.currentCasDate, casTime: bots.currentCasTime, rescheduleCount: bots.rescheduleCount }).from(bots).where(inArray(bots.id, [140,141]));
for (const r of rows) console.log(`Bot ${r.id}: consular ${r.consular} ${r.consularTime} | CAS ${r.cas} ${r.casTime} | reschedules=${r.rescheduleCount}`);
process.exit(0);
```

### Probar si bot 140 sigue bloqueado
```bash
source .env && sshpass -p "$RPI_PASS" scp scripts/_http-probe-140.ts rpi:/home/agetrox/visa-scraper/scripts/_http-probe-140.ts && sshpass -p "$RPI_PASS" ssh rpi "cd /home/agetrox/visa-scraper && npx tsx --env-file=.env scripts/_http-probe-140.ts && rm scripts/_http-probe-140.ts"
```

### Lanzar sniper (en RPi)
```bash
source .env && sshpass -p "$RPI_PASS" scp scripts/_dual-sniper.ts rpi:/home/agetrox/visa-scraper/scripts/_dual-sniper.ts && sshpass -p "$RPI_PASS" ssh rpi "cd /home/agetrox/visa-scraper && nohup npx tsx --env-file=.env scripts/_dual-sniper.ts --commit > logs/dual-sniper.log 2>&1 & echo Launched PID: \$!"
```

### Parar sniper
```bash
source .env && sshpass -p "$RPI_PASS" ssh rpi "ps -eo pid,command --no-headers | grep -E 'tsx.*dual-sniper' | grep -v grep | awk '{print \$1}' | xargs kill && echo Done"
```

## Script principal

`scripts/_dual-sniper.ts` — 3 fases automáticas, cooldown 6h para errores consecutivos.

Parámetros clave:
- `CAS_START = '2026-05-19'`, `CAS_END = '2026-05-22'`
- `GAP_LIMIT_MIN = 15`
- `POLL_INTERVAL_MS = 30_000`
- `COOLDOWN_THRESHOLD = 5` errores → `COOLDOWN_MS = 6h`

## Contexto importante

- Ambos bots comparten credenciales (mismo userId=45936434) pero schedules distintos
- Schedule 64535371 (bot 140) fue bloqueado por la embajada tras polling agresivo de snipers previos
- Bot 141 funciona bien con webshare
- Directo (RPi IP) también está bloqueado para schedule 64535371
- El bloqueo es a nivel de scheduleId en el servidor — no hay bypass
- Monitor 24/7 activo: `b3s4tfhfn` (notifica en POST, phase transition, muerte, heartbeat 6h)

## Instrucciones de uso

Al invocar `/bot-140-141-sniper`:

1. **Verificar estado**: SSH a RPi y leer últimas líneas del log + DB
2. **Probar bot 140**: ejecutar `_http-probe-140.ts` para verificar si el bloqueo levantó
3. **Decidir**: si bot 140 desbloqueado → lanzar sniper. Si sigue bloqueado → informar al usuario
4. **Lanzar**: deploy + launch en RPi con `--commit`
5. **Confirmar**: leer primeros ciclos del log para verificar que arrancó bien
