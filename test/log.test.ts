import { describe, it, expect } from "bun:test";
import { createLogger, type LogSink } from "../src/log.ts";

function capture(): { lines: string[]; sink: LogSink } {
	const lines: string[] = [];
	return { lines, sink: (l) => lines.push(l) };
}

describe("logger", () => {
	it("emits structured JSON lines with module, level, msg, fields", () => {
		const { lines, sink } = capture();
		const log = createLogger("test", sink, "debug");
		log.info("page fetched", { from: 250, status: 200, ms: 42 });
		const entry = JSON.parse(lines[0]!);
		expect(entry).toMatchObject({ level: "info", module: "test", msg: "page fetched", from: 250, status: 200, ms: 42 });
		expect(entry.ts).toBeTruthy();
	});

	it("filters below the minimum level", () => {
		const { lines, sink } = capture();
		const log = createLogger("test", sink, "info");
		log.debug("noisy");
		log.info("kept");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!).msg).toBe("kept");
	});

	it("warn and error always pass at info level", () => {
		const { lines, sink } = capture();
		const log = createLogger("test", sink, "info");
		log.warn("w");
		log.error("e");
		expect(lines).toHaveLength(2);
	});

	it("fields are optional", () => {
		const { lines, sink } = capture();
		const log = createLogger("test", sink, "debug");
		log.debug("plain");
		expect(JSON.parse(lines[0]!).msg).toBe("plain");
	});
});
