// Structured stdout logger. Format:
//   [2026-04-29T03:45:10.123Z] [info] [component] message k=v k="quoted str" k={"obj":1}
// Controlled by LOG_LEVEL env (debug|info|warn|error). Default: info.
// info/debug → stdout, warn/error → stderr so log shippers can split streams.

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveMinLevel(): number {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (raw in LEVELS) return LEVELS[raw as Level];
  return LEVELS.info;
}

const minLevel = resolveMinLevel();

function fmtVal(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return /[\s"=]/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Error) return JSON.stringify({ name: v.name, msg: v.message });
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(
  level: Level,
  component: string,
  msg: string,
  fields?: Record<string, unknown>
): void {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] [${component}] ${msg}`;
  if (fields) {
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      if (v === undefined) continue;
      line += ` ${k}=${fmtVal(v)}`;
    }
  }
  if (level === 'warn' || level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (component: string, msg: string, fields?: Record<string, unknown>) =>
    emit('debug', component, msg, fields),
  info: (component: string, msg: string, fields?: Record<string, unknown>) =>
    emit('info', component, msg, fields),
  warn: (component: string, msg: string, fields?: Record<string, unknown>) =>
    emit('warn', component, msg, fields),
  error: (component: string, msg: string, fields?: Record<string, unknown>) =>
    emit('error', component, msg, fields),
};
