#!/usr/bin/env bash
# M4 on the box itself (Raspberry Pi 4 / 5, Raspberry Pi OS 64-bit, Node >= 22.18, pnpm). From a repo checkout:
#
#   packages/kws-sherpa/scripts/pi-m4.sh --out ~/m4 [--samples <synth dir>] [--wakes <dir>] [--tv <dir>] \
#       [--model gigaspeech-bpe] [--threshold 0.1] [--score 2.0] [--minutes 10]
#
#   --samples  the synthetic set made on any machine with `pnpm --filter @pva/kws-sherpa synth --out <dir>`
#              (Kokoro on a Pi is slow; copy the directory over: rsync -a <dir> pi:~/kws-samples)
#   --wakes    ≥ 50 WAVs of the owner saying the wake phrase *alone*, recorded on the node's own mic
#              (arecord -f S16_LE -r 16000 -c 1 -d 3 wake-01.wav, …); the phrase end is taken from the audio
#   --tv       ≥ 3 h of TV / podcast audio as WAVs (any rate; ffmpeg -i in.mkv -ac 1 -ar 16000 out.wav)
#
# Writes to --out: system.txt, accuracy.json (cost, fire delay, misses, false fires), realtime.json and
# pidstat.txt (CPU % and RSS of the spotter process streaming at real time), summary.txt.
set -euo pipefail

OUT="" SAMPLES="" WAKES="" TV="" MODEL="gigaspeech-bpe" THRESHOLD="0.1" SCORE="2.0" MINUTES="10" THREADS="1"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --samples) SAMPLES="$2"; shift 2 ;;
    --wakes) WAKES="$2"; shift 2 ;;
    --tv) TV="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --threshold) THRESHOLD="$2"; shift 2 ;;
    --score) SCORE="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --threads) THREADS="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
command -v pidstat >/dev/null || { echo "pidstat missing: sudo apt install sysstat" >&2; exit 2; }
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
PKG="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PKG"

{
  uname -a
  grep -m1 -i "model" /proc/device-tree/model 2>/dev/null || tr -d '\0' < /proc/device-tree/model 2>/dev/null || true
  echo
  lscpu | grep -E "Model name|^CPU\(s\)|max MHz" || true
  vcgencmd measure_temp 2>/dev/null || true
  vcgencmd get_throttled 2>/dev/null || true
  node --version
} > "$OUT/system.txt"
cat "$OUT/system.txt"

pnpm install --frozen-lockfile >/dev/null
pnpm --silent download-models "$MODEL" >/dev/null

ARGS=(--model "$MODEL" --threshold "$THRESHOLD" --score "$SCORE" --threads "$THREADS")
ACC=("${ARGS[@]}")
[ -n "$SAMPLES" ] && ACC+=(--samples "$SAMPLES")
[ -n "$WAKES" ] && ACC+=(--positives "$WAKES")
NEG="${TV:-}"
if [ -z "$NEG" ]; then
  # no TV audio given: use whatever speech the samples have, so cost is still measured
  [ -n "$SAMPLES" ] && NEG="$SAMPLES/neg"
fi
[ -n "$NEG" ] && ACC+=(--negatives "$NEG")

echo "== accuracy and cost (as fast as possible, one process)"
/usr/bin/time -v npx tsx scripts/measure-m4.ts "${ACC[@]}" --json "$OUT/accuracy.json" > "$OUT/accuracy.log" 2> "$OUT/time.txt"
grep -E "Maximum resident|Elapsed" "$OUT/time.txt"

[ -n "$NEG" ] || { echo "no --tv or --samples: skipping the real-time run"; exit 0; }
echo "== real time for $MINUTES min, with pidstat"
npx tsx scripts/measure-m4.ts "${ARGS[@]}" --negatives "$NEG" --realtime-minutes "$MINUTES" --json "$OUT/realtime.json" > "$OUT/realtime.log" 2>&1 &
TSX=$!
# tsx starts node as a child; find the process that has the model loaded
PID=""
for _ in $(seq 1 60); do
  PID="$(grep -o 'pid [0-9]*' "$OUT/realtime.log" 2>/dev/null | head -1 | cut -d' ' -f2 || true)"
  [ -n "$PID" ] && break
  sleep 1
done
[ -n "$PID" ] || { echo "measure-m4 did not start" >&2; kill "$TSX" || true; exit 1; }
pidstat -u -r -p "$PID" 1 > "$OUT/pidstat.txt" &
PIDSTAT=$!
wait "$TSX"
kill "$PIDSTAT" 2>/dev/null || true
vcgencmd measure_temp 2>/dev/null >> "$OUT/system.txt" || true
vcgencmd get_throttled 2>/dev/null >> "$OUT/system.txt" || true

# pidstat -u -r prints a CPU line and a memory line per second; %CPU is the 8th field of the CPU lines (one core =
# 100 %), RSS (kB) the 7th of the memory lines.
awk '/%usr/ {mode="cpu"; next} /minflt/ {mode="mem"; next} /^Average/ {next}
     mode=="cpu" && NF>=9 && $8 ~ /^[0-9.]+$/ {print $8 > "/dev/stderr"}
     mode=="mem" && NF>=9 && $7 ~ /^[0-9]+$/ {if ($7>m) m=$7} END {print "max RSS MB", m/1024}' \
  "$OUT/pidstat.txt" 2> "$OUT/cpu.txt" > "$OUT/rss.txt"
sort -n "$OUT/cpu.txt" | awk '{a[NR]=$1} END {print "CPU % of one core: median", a[int(NR*0.5)+1], "p95", a[int(NR*0.95)+1], "samples", NR}' > "$OUT/summary.txt"
cat "$OUT/rss.txt" >> "$OUT/summary.txt"
node -e '
const a = require(process.argv[1])[0]
const p = a.positives, c = a.cost, n = a.continuousNegatives, m = a.nearMisses
const l = []
if (c) l.push(`RTF (fast) ${c.rtfWall}, CPU at real time ${c.cpuPercentOfOneCoreAtRealTime} % of one core, accept p99 ${c.acceptMsPerFrame.p99} ms`)
if (p) l.push(`positives ${p.clips}: misses ${p.misses} (${(p.missRate * 100).toFixed(1)} %), fire delay p50 ${p.fireDelayMsAfterPhraseEnd.p50} ms p95 ${p.fireDelayMsAfterPhraseEnd.p95} ms`)
if (n) l.push(`negatives ${n.hours} h: ${n.fires} fires (${n.firesPerHour} / h)`)
if (m) l.push(`near misses ${m.clips}: ${m.clipsWithFire} fired`)
l.push(`load ${a.loadMs} ms`)
console.log(l.join("\n"))
' "$OUT/accuracy.json" >> "$OUT/summary.txt"
node -e 'const r = require(process.argv[1])[0].realtime; console.log(`real time ${r.minutes} min: process.cpuUsage ${r.cpuPercentOfOneCore} % of one core`)' "$OUT/realtime.json" >> "$OUT/summary.txt"
echo "== summary ($OUT/summary.txt)"
cat "$OUT/summary.txt"
