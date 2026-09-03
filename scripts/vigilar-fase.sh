#!/bin/bash
# Vigilante del experimento de fase, para el Monitor de la sesion.
#
# Mira DOS cosas y solo habla cuando alguna cambia:
#
#   1. ¿La rejilla esta funcionando?  Los huecos de dentro y de fuera de la ventana
#      tienen que parecerse. Mientras no se parezcan, la razon mide el hueco y no la
#      fase. Es la condicion que hace utilizable todo lo demas.
#   2. ¿Ya hay veredicto?  Sale de los ESTRATOS por hueco, cada uno con su intervalo de
#      confianza. El analisis agrupado sigue contaminado y no decide.
#
# El estado se saca del reporte, que ya trae las dos cosas. Ver
# `src/services/experimento-estadistica.ts`.
cd /Users/juanortega/visa-scraper || exit 1
ANTERIOR=""
while true; do
  SAL=$(npx tsx --env-file=.env scripts/reporte-experimento-fase.ts --dias 3 2>&1)
  if echo "$SAL" | grep -q "sin filas"; then
    ESTADO="sin-datos"; DET="ningun bot con phase_experiment"
  elif echo "$SAL" | grep -q "contaminada"; then
    ESTADO="huecos-sucios"
    DET="$(echo "$SAL" | grep -o 'Hueco antes del poll:.*' | head -1) · la rejilla todavia no limpia la muestra"
  else
    # El veredicto sale de los ESTRATOS, no del agrupado. El agrupado sigue contaminado
    # (112 s de hueco dentro contra 59 s fuera) y por eso no decide. Decir "huecos
    # comparables" aqui seria afirmar algo que no es cierto del conjunto.
    VER=$(echo "$SAL" | grep -oE "la ventana (GANA|PIERDE)|empate|sin veredicto todavia" | head -1)
    EST=$(echo "$SAL" | grep -oE "[0-9]+ estratos? limpio" | head -1)
    ESTRA=$(echo "$SAL" | grep -E "^· " | sed 's/  */ /g' | tr '\n' ' ')
    ESTADO="${VER:-sin-veredicto}"
    DET="${EST:-sin estratos} · $ESTRA"
  fi
  if [ "$ESTADO" != "$ANTERIOR" ]; then
    echo "[fase] $ESTADO · $DET"
    ANTERIOR="$ESTADO"
  fi
  sleep 900
done
