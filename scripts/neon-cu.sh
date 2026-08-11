#!/bin/bash
# Mide el CU real del proyecto visa-bot en Neon.
#
# OJO: Neon actualiza `cpu_used_sec` por lotes, no en continuo. Una ventana de
# 25 min dio 0 y despues un salto de 3,240s. Para un ritmo confiable hay que
# medir sobre varias HORAS, no minutos.
#
# Uso:
#   ./scripts/neon-cu.sh --marca     guarda la marca de agua de este momento
#   ./scripts/neon-cu.sh             compara contra la marca guardada
set -u
PROJ=icy-hat-81282016          # visa-bot, org "Emmy Daniela" (emmy@30x.org)
SNAP="$(dirname "$0")/.neon-cu-watermark.txt"
JULIO_CU=0.962                 # promedio facturado en julio 2026 ($77.73)

TOK=$(python3 -c "import json;print(json.load(open('$HOME/.config/neonctl/credentials.json'))['access_token'])" 2>/dev/null) \
  || { echo "Sin credenciales. Corre: neonctl auth   (con la cuenta emmy@30x.org)"; exit 1; }

RESP=$(curl -s -H "Authorization: Bearer $TOK" "https://console.neon.tech/api/v2/projects/$PROJ")
echo "$RESP" | grep -q cpu_used_sec || { echo "Token vencido o cuenta equivocada. Corre: neonctl auth"; exit 1; }

NOW_SEC=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['cpu_used_sec'])")
NOW_TS=$(date -u +%s)

if [ "${1:-}" = "--marca" ]; then
  echo "$NOW_TS|$NOW_SEC" > "$SNAP"
  echo "Marca guardada: $(date -u '+%Y-%m-%d %H:%M') UTC | cpu_used_sec=$NOW_SEC"
  echo "Volve a correr el script sin argumentos dentro de unas horas."
  exit 0
fi

[ -f "$SNAP" ] || { echo "No hay marca. Corre primero: $0 --marca"; exit 1; }
IFS='|' read -r B_TS B_SEC < "$SNAP"

python3 -c "
b_ts,b_sec,n_ts,n_sec,julio = $B_TS,$B_SEC,$NOW_TS,$NOW_SEC,$JULIO_CU
h=(n_ts-b_ts)/3600; cu=(n_sec-b_sec)/3600
print(f'\n  Ventana     : {h:.1f} horas')
print(f'  CU-hora     : {cu:.3f}')
if h < 3:
    print('\n  ADVERTENCIA: menos de 3 horas. Neon actualiza por lotes,')
    print('  el numero todavia no es confiable. Espera mas.')
if h > 0 and cu > 0:
    r = cu/h
    print(f'  CU PROMEDIO : {r:.3f}     (julio fue {julio})')
    print(f'  Reduccion   : {julio/r:.1f}x')
    print(f'  Proyeccion  : {r*744:.0f} CU-hora/mes = \${r*744*0.106:.2f}   (julio: \$75.88)')
print()
"
