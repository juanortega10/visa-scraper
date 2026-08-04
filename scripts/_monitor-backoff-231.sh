#!/usr/bin/env bash
# One-shot health snapshot for the account-ban backoff fix (bot 231 + fleet).
# Prints a compact status line + anomaly flags. Designed to be run on a loop.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

API="https://visa.homiapp.xyz/api"
now_bogota() { TZ=America/Bogota date '+%Y-%m-%d %H:%M:%S'; }

# --- Bot 231: poll cadence (proof the backoff holds) ---
polls=$(curl -s "$API/bots/231/logs/polls?limit=8" -H "x-api-key: $API_KEY")
b231=$(curl -s "$API/bots/231" -H "x-api-key: $API_KEY")
status=$(echo "$b231" | jq -r '.status')
newest=$(echo "$polls" | jq -r '.[0].createdAt')
newest_status=$(echo "$polls" | jq -r '.[0].status')
newest_cls=$(echo "$polls" | jq -r '.[0].connectionInfo.blockClassification // "-"')
age_min=$(( ( $(date +%s) - $(date -u -jf "%Y-%m-%dT%H:%M:%S" "${newest%.*}" +%s 2>/dev/null || date -u -d "$newest" +%s) ) / 60 ))

# gaps between the last few polls (minutes) — strip fractional seconds for fromdate
gaps=$(echo "$polls" | jq -r '[.[].createdAt | sub("\\.[0-9]+Z$";"Z")] as $t | [range(0; ($t|length)-1) | (($t[.]|fromdate) - ($t[.+1]|fromdate))/60 | floor] | @csv')

# any ok poll in last 24h => self-healed at some point
ok24=$(curl -s "$API/bots/231/logs/polls?limit=200" -H "x-api-key: $API_KEY" | jq '[.[] | select(.status=="ok")] | length')

# --- Fleet: resurrection activity + guard activity in RPi journal (last 30 min) ---
jr=$(sshpass -p "$RPI_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 rpi \
  "journalctl -u visa-trigger --since '30 min ago' --no-pager 2>/dev/null" 2>/dev/null || echo "")
resurrects=$(echo "$jr" | grep -c 'event=chain_resurrected' || true)
guard_skips=$(echo "$jr" | grep -c 'account-ban backoff, skipping' || true)
resurrect_ids=$(echo "$jr" | grep 'event=chain_resurrected' | grep -oE 'bot=[0-9]+' | grep -oE '[0-9]+' | sort -u || true)
resurrect_bots=$(echo "$resurrect_ids" | tr '\n' ' ')
# REGRESSION signal: a resurrected bot whose latest poll is account_ban should have been HELD, not resurrected.
banned_resurrected=""
for rb in $resurrect_ids; do
  [ -z "$rb" ] && continue
  c=$(curl -s "$API/bots/$rb/logs/polls?limit=1" -H "x-api-key: $API_KEY" 2>/dev/null | jq -r '.[0].connectionInfo.blockClassification // "-"')
  [ "$c" = "account_ban" ] && banned_resurrected="$banned_resurrected $rb"
done

# --- Newly paused bots in last 30 min (should be 0 — no auto-pause anymore) ---
newly_paused=$(sshpass -p "$RPI_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 rpi \
  "journalctl -u visa-trigger --since '30 min ago' --no-pager 2>/dev/null | grep -c 'event=bot_paused'" 2>/dev/null || echo "?")

# --- Stateful verdict: compare newest poll vs previous tick (proves the gap widens) ---
STATE="/private/tmp/claude-501/-Users-juanortega-visa-scraper/38bd9092-26a4-445f-ba25-a9af5585e97b/scratchpad/mon231.state"
prev_newest=""; [ -f "$STATE" ] && prev_newest=$(cat "$STATE")
echo "$newest" > "$STATE"

flags=""
# 231 must NEVER be resurrected while account-banned (that was the bug)
if echo " ${resurrect_bots:-} " | grep -q ' 231 '; then flags="$flags 231-RESURRECTED!"; fi
if [ -n "${banned_resurrected// /}" ]; then flags="$flags BANNED-BOTS-RESURRECTED:${banned_resurrected}!"; fi
if [ "$status" = "paused" ]; then flags="$flags 231-PAUSED!"; fi
if [ "$newest_status" = "ok" ]; then flags="$flags SELF-HEALED-OK✓"; fi

if [ -n "$prev_newest" ] && [ "$prev_newest" != "$newest" ]; then
  # a NEW poll landed since last tick — measure the real gap it just closed
  jgap=$(jq -rn --arg a "$newest" --arg b "$prev_newest" '(($a|sub("\\.[0-9]+Z$";"Z")|fromdate)-($b|sub("\\.[0-9]+Z$";"Z")|fromdate))/60|floor')
  if [ "$newest_status" = "tcp_blocked" ] && [ "$newest_cls" = "account_ban" ]; then
    if [ "$jgap" -lt 60 ] 2>/dev/null; then flags="$flags NEW-BAN-POLL-gap=${jgap}m<60-BAD"; else flags="$flags BACKOFF-HELD-gap=${jgap}m✓"; fi
  else
    flags="$flags NEW-POLL(${newest_status},gap=${jgap}m)"
  fi
else
  flags="$flags HOLDING(age=${age_min}m,no-new-poll)"
fi
[ -z "$flags" ] && flags="OK"

echo "[$(now_bogota) Bogota] bot231 status=$status last=${newest_status}/${newest_cls} age=${age_min}m recentGaps(min)=[$gaps] ok/24h=$ok24 | fleet resurrects/30m=$resurrects banned-among-them=[${banned_resurrected:- none}] => $flags"
