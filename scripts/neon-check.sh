#!/bin/bash
# Verificador de costo de compute en Neon — visa-scraper
# Uso: ./neon-check.sh [etiqueta]
# Captura las metricas que determinan el CU: tamano del working set, cache hit,
# seq scans sobre poll_logs, y el costo real de la query del dashboard.

set -u
LABEL="${1:-sin-etiqueta}"
ENVFILE=/Users/juanortega/visa_frontend/.env.local
export $(grep -E '^DATABASE_URL=' "$ENVFILE" | head -1)
PSQL="/opt/homebrew/bin/psql"
STAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "═══════════════════════════════════════════════════════════"
echo " NEON COST CHECK — $LABEL"
echo " $STAMP (UTC)"
echo "═══════════════════════════════════════════════════════════"

echo
echo "── 1. Working set: poll_logs (heap vs indices) ──"
$PSQL "$DATABASE_URL" -X -q -c "
select
  pg_size_pretty(pg_relation_size('poll_logs'))                                    as heap,
  pg_size_pretty(pg_indexes_size('poll_logs'))                                     as indices,
  pg_size_pretty(pg_total_relation_size('poll_logs'))                              as total,
  (select count(*) from poll_logs)                                                 as filas,
  pg_size_pretty(pg_database_size(current_database()))                             as db_total;"

echo "── 2. Indices de poll_logs (uso y peso) ──"
$PSQL "$DATABASE_URL" -X -q -c "
select indexrelname as indice, idx_scan as scans,
       pg_size_pretty(pg_relation_size(indexrelid)) as peso
from pg_stat_user_indexes where relname='poll_logs' order by pg_relation_size(indexrelid) desc;"

echo "── 3. Cache hit ratio (objetivo: >99%) ──"
$PSQL "$DATABASE_URL" -X -q -c "
select round(100.0*blks_hit/nullif(blks_hit+blks_read,0),2) as db_cache_pct,
       blks_read as db_blks_read
from pg_stat_database where datname=current_database();"

echo "── 4. I/O por tabla (poll_logs deberia dejar de dominar) ──"
$PSQL "$DATABASE_URL" -X -q -c "
select relname as tabla, heap_blks_read as bloques_leidos,
       round(100.0*heap_blks_read/nullif(sum(heap_blks_read) over (),0),1) as pct_del_io
from pg_statio_user_tables order by heap_blks_read desc limit 5;"

echo "── 5. Seq scans sobre poll_logs (objetivo: que dejen de crecer) ──"
$PSQL "$DATABASE_URL" -X -q -c "
select seq_scan as seq_scans, seq_tup_read as filas_leidas_secuencial,
       idx_scan as idx_scans,
       round(seq_tup_read/nullif(seq_scan,0)) as filas_por_seqscan
from pg_stat_user_tables where relname='poll_logs';"

echo "── 6. Volumen de escritura (ultimos 5 dias) ──"
$PSQL "$DATABASE_URL" -X -q -c "
select date_trunc('day',created_at)::date as dia, count(*) as filas,
       count(distinct bot_id) as bots,
       round(count(*)::numeric/nullif(count(distinct bot_id),0)) as filas_por_bot
from poll_logs where created_at > now()-interval '5 days'
group by 1 order by 1 desc;"

echo "── 7. Heartbeat activo? (polls_since_prev>1 = si) ──"
$PSQL "$DATABASE_URL" -X -q -c "
select case when polls_since_prev=1 then '1 (sin heartbeat)' else '>1 (heartbeat ON)' end as tipo,
       count(*) as filas,
       round(100.0*count(*)/sum(count(*)) over (),1) as pct
from poll_logs where created_at > now()-interval '6 hours' group by 1 order by 2 desc;"

echo "── 8. COSTO REAL de la query del dashboard (fetchPollStats) ──"
$PSQL "$DATABASE_URL" -X -q -c "
explain (analyze, buffers, costs off, timing off, summary on)
select bot_id,
       coalesce(sum(polls_since_prev),0)::int as total24h,
       count(*) filter (where status='tcp_blocked')::int as tcp,
       count(*) filter (where status not in ('ok','filtered_out','tcp_blocked'))::int as err,
       count(distinct floor(extract(epoch from created_at)/300))::int as buckets
from poll_logs where created_at >= now()-interval '24 hours' group by bot_id;" \
 2>&1 | grep -Ei "Seq Scan|Index Only Scan|Index Scan|Bitmap|Buffers: shared|Execution Time" | head -8

echo
echo "═══════════════════════════════════════════════════════════"
echo " CRITERIOS DE EXITO"
echo "   #8 debe decir 'Index Only Scan', NO 'Seq Scan'"
echo "   #8 buffers read debe bajar de ~52,000 a <5,000"
echo "   #3 cache hit debe subir hacia 99%"
echo "   #1 total debe bajar de 1731 MB hacia ~200 MB"
echo "═══════════════════════════════════════════════════════════"
