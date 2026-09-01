#!/bin/bash
# Vigilante del sniper del bot 299, para el Monitor de la sesion.
#
# El verificador YA distingue tres estados y los devuelve en su codigo de salida:
#
#   0  verde        todos los verificadores pasan
#   1  regresion    algo medible empeoro
#   2  sin veredicto  falta muestra en alguno
#
# El envoltorio anterior aplastaba el 2 en "el sniper esta bloqueado y no deja muestra".
# Eso es falso y ya engaño dos veces el 2026-09-01: el sniper escaneaba cada minuto y lo
# que faltaba era muestra de V7, que mira bots es-pe POLLEANDO. El bot 299 no pollea
# desde que se le puso `pollEnvironments: []` para sacarle carga a la ruta bloqueada,
# entonces V7 se queda sin muestra por diseño.
#
# Aqui se separan las dos preguntas:
#   1. ¿El sniper escanea?  -> edad del ultimo `sniper_scans`. Esto SI es grave.
#   2. ¿Hay regresion?      -> codigo de salida del verificador.
#
# Habla solo cuando el estado CAMBIA.
cd /Users/juanortega/visa-scraper || exit 1
HUECO_MIN=8          # escanea 10-17 veces por hora: 8 min sin nada es un hueco de verdad
ANTERIOR=""
SOSPECHA=0     # una regresion se confirma en dos vueltas antes de hablar
while true; do
  MIN=$(npx tsx --env-file=.env scripts/_edad-sniper.ts 2>/dev/null | tail -1)
  if ! [ "$MIN" -ge 0 ] 2>/dev/null; then
    ESTADO="sonda-caida"; DET="no pude leer sniper_scans"
  elif [ "$MIN" -ge "$HUECO_MIN" ]; then
    ESTADO="sniper-parado"; DET="sin escanear desde hace $MIN min · revisar peru-sniper-299 en el RPi"
  else
    SAL=$(npx tsx --env-file=.env scripts/verificar-camino-critico.ts 2>&1); COD=$?
    case $COD in
      0) ESTADO="ok"; DET="10 de 10 · ultimo escaneo hace $MIN min"; SOSPECHA=0 ;;
      # "Sin veredicto" NO es un problema: quiere decir que a algun verificador le falta
      # muestra. Pasa cada vez que los tres bots es-pe estan en backoff a la vez, o sea
      # varias veces al dia. Se informa dentro del estado `ok` en vez de despertar a
      # nadie.
      2) ESTADO="ok"
         DET="$(echo "$SAL" | grep -o 'SIN VEREDICTO en [0-9]*: .*' | head -1) · el sniper escanea (hace $MIN min)"
         SOSPECHA=0 ;;
      # Una regresion se CONFIRMA antes de hablar. El 2026-09-01 dos alarmas salieron por
      # baches de 2 minutos: un `HTTP 502` del portal, y un re-login con `hasTokens:false`
      # que limpio el sello del token y otro login repuso enseguida. Las dos veces el
      # mecanismo estaba funcionando. Una regresion de verdad aguanta cinco minutos.
      *) if [ "${SOSPECHA:-0}" -eq 0 ]; then
           SOSPECHA=1; ESTADO="$ANTERIOR"
         else
           ESTADO="regresion"
           DET="confirmada en dos vueltas · $(echo "$SAL" | grep '\[FALLA\]' | sed 's/  */ /g' | cut -c1-120 | tr '\n' ' ')"
         fi ;;
    esac
  fi
  if [ "$ESTADO" != "$ANTERIOR" ]; then
    echo "[sniper-299] $ESTADO · $DET"
    ANTERIOR="$ESTADO"
  fi
  sleep 300
done
