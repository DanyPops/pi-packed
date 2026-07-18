/**
 * log.ts — structured logging for the service. JSON lines to stderr
 * (stdout belongs to CLI output; the TUI owns the terminal UI).
 * Level via PI_PACKED_LOG_LEVEL (debug|info|warn|error, default info).
 * Sinks are injectable so tests can capture without a terminal.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (line: string) => void;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS = new Set(Object.keys(ORDER));

export interface LogFields {
	[key: string]: unknown;
}

export interface Logger {
	debug(msg: string, fields?: LogFields): void;
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
}

function envLevel(): LogLevel {
	const raw = process.env["PI_PACKED_LOG_LEVEL"] ?? "info";
	return (LEVELS.has(raw) ? raw : "info") as LogLevel;
}

export function createLogger(module: string, sink: LogSink = (l) => console.error(l), minLevel?: LogLevel): Logger {
	const threshold = ORDER[minLevel ?? envLevel()];
	function emit(level: LogLevel, msg: string, fields?: LogFields): void {
		if (ORDER[level] < threshold) return;
		sink(JSON.stringify({ ts: new Date().toISOString(), level, module, msg, ...fields }));
	}
	return {
		debug: (m, f) => emit("debug", m, f),
		info: (m, f) => emit("info", m, f),
		warn: (m, f) => emit("warn", m, f),
		error: (m, f) => emit("error", m, f),
	};
}
