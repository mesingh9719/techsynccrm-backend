/** Minimal RFC 5545 calendar file for a single event (used for demo booking confirmations). */

const escapeText = (value) => String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1')
const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** Lines longer than 75 octets must be folded (continuation lines start with a space). */
function fold(line) {
  const out = []
  let rest = line
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--
    out.push(rest.slice(0, cut))
    rest = ` ${rest.slice(cut)}`
  }
  out.push(rest)
  return out.join('\r\n')
}

/**
 * @param {{ uid: string, start: Date, durationMinutes: number, summary: string, description?: string, url?: string }} event
 */
export function buildIcs({ uid, start, durationMinutes, summary, description, url }) {
  const end = new Date(start.getTime() + durationMinutes * 60_000)
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TechSync CRM//Demo booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escapeText(summary)}`,
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    ...(url ? [`URL:${url}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n')
}
