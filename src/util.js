export function nowIso(now) {
  if (!now) return new Date().toISOString();
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid time: ${now}`);
  return d.toISOString();
}

export function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

export function addDays(iso, days) {
  return addMinutes(iso, days * 1440);
}

export function isAfter(aIso, bIso) {
  return Date.parse(aIso) > Date.parse(bIso);
}
