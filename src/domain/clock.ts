/**
 * 时钟抽象。默认读取系统时间；测试可替换为固定/可控时钟，
 * 以验证“迟到点检按实际检查时间归属”“重启后时点延续”等逻辑。
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}

export function parseTime(value: string): number {
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new Error(`非法时间: ${value}`);
  }
  return t;
}

export function addMinutesIso(baseIso: string, minutes: number): string {
  return new Date(parseTime(baseIso) + minutes * 60_000).toISOString();
}

export function msToIsoDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "无限制";
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const totalMinutes = Math.round(abs / 60_000);
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0 || parts.length === 0) parts.push(`${m}分钟`);
  return sign + parts.join("");
}
