/** TTLCache — the smart-proxy concern, nothing more. */
export class TTLCache {
	private m = new Map<string, { body: string; expires: number }>();
	constructor(private ttlMs = 5 * 60_000) {}

	get(key: string): string | undefined {
		const e = this.m.get(key);
		if (!e) return undefined;
		if (Date.now() > e.expires) {
			this.m.delete(key);
			return undefined;
		}
		return e.body;
	}

	set(key: string, body: string): void {
		this.m.set(key, { body, expires: Date.now() + this.ttlMs });
	}
}
