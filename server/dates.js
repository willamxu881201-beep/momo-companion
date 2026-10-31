// Calendar helpers. Dates are plain 'YYYY-MM-DD' strings in the family's
// time zone; arithmetic happens on UTC midnights so DST can never shift a day.

const DAY_MS = 86400000;
const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date: ${s}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

export function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(s, n) {
  return formatDate(parseDate(s) + n * DAY_MS);
}

export function weekday(s) {
  return new Date(parseDate(s)).getUTCDay();
}

export function weekdayZh(s) {
  return WEEKDAY_ZH[weekday(s)];
}

export function isDate(s) {
  if (typeof s !== 'string') return false;
  try {
    return formatDate(parseDate(s)) === s;
  } catch {
    return false;
  }
}

// "Now" in the given IANA time zone: { date: 'YYYY-MM-DD', time: 'HH:MM', minutes }.
export function nowIn(timeZone, at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  return { date, time, minutes: +parts.hour * 60 + +parts.minute };
}

export function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

// 10月28日 周三
export function dateZh(s) {
  const [, mo, d] = s.split('-');
  return `${+mo}月${+d}日 ${weekdayZh(s)}`;
}
