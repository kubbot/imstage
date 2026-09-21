/** Deterministic calendar dates; rendering never consults the viewer's clock. */
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function calendarToday(now = new Date(), timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function formatCalendarDate(date, referenceDate) {
  if (!isCalendarDate(date)) return date || '';
  if (date === referenceDate) return '今天';
  if (isCalendarDate(referenceDate) && Date.parse(`${referenceDate}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`) === 86400000) return '昨天';
  const [year, month, day] = date.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}
export function isDateMarker(text) {
  return typeof text === 'string' && /^(今天|昨天|前天|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)(\s+\d{1,2}:\d{2})?$/.test(text.trim());
}
/** A typed dated timeline uses one separator per day; legacy drafts retain their date text. */
export function timelinePresentation(scene) {
  const dated = scene.messages.some(m => isCalendarDate(m.date));
  const header = dated ? '' : scene.date;
  let previousDate = '';
  let previousTime = '';
  let lastMarker = header?.trim() || '';
  return { header, entries: scene.messages.map(message => {
    const date = message.date || previousDate;
    const dayChanged = Boolean(dated && date && date !== previousDate);
    const dateLabel = dayChanged ? formatCalendarDate(date, scene.referenceDate) : '';
    const marker = message.type === 'system' && isDateMarker(message.text);
    // Legacy duplicate only, or redundant typed-date marker. Do not hide arbitrary system content.
    const hidden = Boolean(marker && ((dated && date && (message.text.trim() === dateLabel || message.text.trim() === formatCalendarDate(date, scene.referenceDate) || message.text.trim() === date)) || (!dated && message.text.trim() === lastMarker)));
    const showTime = Boolean(!hidden && message.time && (dayChanged || message.time !== previousTime));
    if (dateLabel) lastMarker = dateLabel;
    if (!hidden) { lastMarker = marker ? message.text.trim() : ''; previousTime = message.time; }
    previousDate = date;
    return { id: message.id, dateLabel, showTime, hidden };
  }) };
}
