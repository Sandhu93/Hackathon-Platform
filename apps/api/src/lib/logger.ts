import { redactValue } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, line: string) => void;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const consoleSink: LogSink = (level, line) => {
  console[level](line);
};

export interface LoggerOptions {
  level: LogLevel;
  bindings?: Record<string, unknown>;
  sink?: LogSink;
}

/** Structured JSON-lines logger. Every field passes through redaction before it is serialised. */
export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? consoleSink;
  const threshold = ORDER[options.level];
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < threshold) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      service: 'hackathon-api',
      ...(redactValue({ ...bindings, ...fields }) as Record<string, unknown>),
    };
    sink(level, JSON.stringify(entry));
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
