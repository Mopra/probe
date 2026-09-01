export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? '').trim().toLowerCase();
  return ORDER[raw as Level] ?? ORDER.info;
}

/**
 * JSON serialisation that cannot itself throw. A log line that crashes the
 * process it was describing is the worst possible failure mode for a daemon
 * that runs unattended under systemd.
 */
function serialise(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record, (_key, value) => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      if (typeof value === 'bigint') return value.toString();
      return value;
    });
  } catch {
    return JSON.stringify({
      ts: record.ts,
      level: record.level,
      scope: record.scope,
      msg: record.msg,
      log_error: 'fields were not serialisable',
    });
  }
}

function emit(
  scope: string,
  bound: Record<string, unknown>,
  level: Level,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (ORDER[level] < threshold()) return;

  const line = serialise({
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...bound,
    ...fields,
  });

  // stderr for errors so journald and Vercel classify them correctly; stdout
  // for everything else. Written directly rather than via console so library
  // code has exactly one output path.
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function make(scope: string, bound: Record<string, unknown>): Logger {
  return {
    debug: (msg, fields) => emit(scope, bound, 'debug', msg, fields),
    info: (msg, fields) => emit(scope, bound, 'info', msg, fields),
    warn: (msg, fields) => emit(scope, bound, 'warn', msg, fields),
    error: (msg, fields) => emit(scope, bound, 'error', msg, fields),
    child: (fields) => make(scope, { ...bound, ...fields }),
  };
}

/** Minimal leveled logger, JSON lines. Used by every package. */
export function logger(scope: string): Logger {
  return make(scope, {});
}
