#!/bin/bash
# Compara el I/O actual contra la marca de agua tomada justo despues del arreglo
# de costo (2026-08-04). El I/O leido de disco es el proxy directo del CU que
# factura Neon: en Neon el storage es desagregado, asi que cada bloque "read"
# es una llamada de red al pageserver, y eso es lo que dispara el autoscaler.
#
# Uso: ./scripts/neon-delta.sh
set -u
SNAP="$(dirname "$0")/.neon-baseline.txt"
[ -f "$SNAP" ] || { echo "Falta $SNAP"; exit 1; }
export $(grep -E '^DATABASE_URL=' /Users/juanortega/visa_frontend/.env.local | head -1)
PSQL=/opt/homebrew/bin/psql

IFS='|' read -r B_TS B_READ B_HIT B_INS B_UPD B_XACT B_POLLREAD B_ROWS < "$SNAP"
NOW_ROW=$($PSQL "$DATABASE_URL" -X -t -A -F'|' -c "select now(), blks_read, blks_hit, tup_inserted, tup_updated, xact_commit, (select heap_blks_read from pg_statio_user_tables where relname='poll_logs'), (select count(*) from poll_logs) from pg_stat_database where datname=current_database();")
IFS='|' read -r N_TS N_READ N_HIT N_INS N_UPD N_XACT N_POLLREAD N_ROWS <<< "$NOW_ROW"

python3 - "$B_TS" "$B_READ" "$B_POLLREAD" "$B_INS" "$B_ROWS" "$N_TS" "$N_READ" "$N_POLLREAD" "$N_INS" "$N_ROWS" <<'PY'
import sys, datetime
b_ts,b_read,b_poll,b_ins,b_rows,n_ts,n_read,n_poll,n_ins,n_rows = sys.argv[1:11]
def p(s):
    # Postgres emite "+00"; fromisoformat exige "+00:00". Normalizamos y
    # devolvemos siempre naive-UTC para poder restar sin conflicto de tz.
    s = s.strip().replace(' ', 'T', 1)
    for suf in ('+00', '-00'):
        if s.endswith(suf):
            s = s[:-3] + '+00:00'
            break
    d = datetime.datetime.fromisoformat(s)
    return d.replace(tzinfo=None) if d.tzinfo is None else d.astimezone(datetime.timezone.utc).replace(tzinfo=None)
h = (p(n_ts)-p(b_ts)).total_seconds()/3600
d_read = int(n_read)-int(b_read); d_poll = int(n_poll)-int(b_poll); d_ins = int(n_ins)-int(b_ins)
print(f"\n  Ventana medida     : {h:.1f} horas desde el arreglo\n")
print(f"  Bloques leidos     : {d_read:,}          ({d_read/h:,.0f}/hora)")
print(f"    de poll_logs     : {d_poll:,}          ({100*d_poll/d_read if d_read else 0:.1f}% del total)")
print(f"  Filas insertadas   : {d_ins:,}          ({d_ins*24/h:,.0f}/dia)")
print(f"  Filas en poll_logs : {int(n_rows):,}")
print(f"\n  ── Referencia historica (antes del arreglo) ──")
print(f"  poll_logs leia ~10,700,000 bloques/dia  = ~446,000/hora")
print(f"  se insertaban  ~120,000 filas/dia")
print(f"\n  ── Lectura ──")
r = d_poll/h if h else 0
if r < 50_000:   print("  I/O muy por debajo del historico. El compute deberia estar cerca del piso.")
elif r < 200_000: print("  I/O bastante por debajo del historico. Mejora clara.")
else:            print("  I/O sigue alto — revisar si algo volvio a hacer seq scan sobre poll_logs.")
print("\n  El numero que manda igual es CU-hora en la consola de Neon.\n")
PY
