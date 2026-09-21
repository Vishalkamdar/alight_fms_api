const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24,
};

/** Parses simple duration strings like "30m", "7d", "3600" (seconds) into seconds. */
export function parseDurationToSeconds(value: string): number {
  const match = /^(\d+)\s*([smhd])?$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration string: "${value}"`);
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  return amount * UNIT_SECONDS[unit];
}
