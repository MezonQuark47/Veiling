/**
 * Calendar reminders for a sale, made in the browser: a Google Calendar link
 * and an .ics file for Apple Calendar, Outlook and the rest. Nothing is sent
 * anywhere; the person adds the event to their own calendar.
 */

export interface Reminder {
  /** Event title. */
  title: string;
  /** Unix seconds. */
  start: number;
  end: number;
  details: string;
  url: string;
  /** Alarms, in minutes before the event starts (0: when it starts). */
  alarms: number[];
  /** Also an alarm this many minutes before the event ends, if set. */
  alarmBeforeEnd?: number;
  /** Stable id, so adding the same reminder twice updates one event. */
  uid: string;
}

const stamp = (unixSecs: number) =>
  new Date(unixSecs * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function googleCalendarUrl(r: Reminder): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: r.title,
    dates: `${stamp(r.start)}/${stamp(r.end)}`,
    details: `${r.details}\n\n${r.url}`,
    location: r.url,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Text in an .ics value: backslashes, commas, semicolons and newlines escaped. */
const escapeText = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** .ics lines are at most 75 bytes; longer ones continue on lines that start with a space. */
function fold(line: string): string {
  const bytes = new TextEncoder();
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    const limit = out.length === 0 ? 75 : 74;
    if (bytes.encode(current + ch).length > limit) {
      out.push(current);
      current = ch;
    } else current += ch;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function icsFile(r: Reminder): string {
  const alarm = (trigger: string) => [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(r.title)}`,
    `TRIGGER${trigger}`,
    "END:VALARM",
  ];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Veiling//Sale reminders//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${r.uid}`,
    `DTSTAMP:${stamp(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${stamp(r.start)}`,
    `DTEND:${stamp(r.end)}`,
    `SUMMARY:${escapeText(r.title)}`,
    `DESCRIPTION:${escapeText(`${r.details}\n\n${r.url}`)}`,
    `URL:${r.url}`,
    ...r.alarms.flatMap((m) => alarm(`:-PT${m}M`)),
    ...(r.alarmBeforeEnd !== undefined ? alarm(`;RELATED=END:-PT${r.alarmBeforeEnd}M`) : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export function downloadIcs(r: Reminder, fileName: string) {
  const blob = new Blob([icsFile(r)], { type: "text/calendar;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
