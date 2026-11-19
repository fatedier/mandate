import fs from "node:fs";
import path from "node:path";

/**
 * A stand-in for a greenhouse a schedule watches, as files in `dir`: its
 * sensor log (sensors.log) and its moisture per bed (moisture.json, in tenths
 * of a baseline of 10). `checkScript` is a check as the personal agent would
 * write one: bash, grep and arithmetic, no network. It reports one item per
 * signature in the log (Mandate drops the ones it delivered before), and an
 * item for the day when a bed's moisture is over three times the baseline it
 * keeps in its state; the log's last lines are its output.
 */
export function fakeGreenhouse(dir: string): { logLine(text: string): void; setMoisture(bed: string, ratio: number): void; checkScript: string } {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "sensors.log");
  const moisture = path.join(dir, "moisture.json");
  fs.writeFileSync(log, "INFO started\n");
  const levels: Record<string, number> = { bed5: 10 };
  const writeLevels = () => fs.writeFileSync(moisture, JSON.stringify(levels));
  writeLevels();
  // POSIX sh: the runner's shell may not be bash. Signatures are the test's
  // own words: no quotes or backslashes to escape.
  const checkScript = `dir='${dir}'
state=$(cat "$MANDATE_CHECK_STATE" 2>/dev/null || echo '{}')
base=$(printf '%s' "$state" | grep -o '"baseline":[0-9]*' | grep -o '[0-9]*$' || true)
rate=$(grep -o '"bed5":[0-9]*' "$dir/moisture.json" | grep -o '[0-9]*$')
[ -n "$base" ] || base=$rate
items=""
signatures=$(grep -o 'ERROR .*' "$dir/sensors.log" | sed 's/^ERROR //' | sort -u)
for sig in $(printf '%s\\n' "$signatures" | tr ' ' '~'); do
  title=$(printf '%s' "$sig" | tr '~' ' ')
  id="sig:$(printf '%s' "$title" | cksum | cut -d' ' -f1)"
  items="$items{\\"id\\":\\"$id\\",\\"title\\":\\"$title\\"},"
done
message="new sensor alerts"
if [ "$rate" -gt $((base * 3)) ]; then
  items="$items{\\"id\\":\\"rate:bed5:$(date -u +%F)\\",\\"title\\":\\"bed 5 moisture at $((rate / base))x baseline\\"},"
  message="bed 5 moisture over 3x baseline"
fi
tail -n 3 "$dir/sensors.log"
printf '{"wake":true,"message":"%s","state":{"baseline":%s},"items":[%s]}\\n' "$message" "$base" "\${items%,}"
`;
  return {
    logLine: (text) => fs.appendFileSync(log, `${text}\n`),
    setMoisture: (bed, ratio) => { levels[bed] = Math.round(ratio * 10); writeLevels(); },
    checkScript
  };
}
