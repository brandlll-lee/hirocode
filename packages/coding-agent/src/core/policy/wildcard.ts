export namespace Wildcard {
	export function match(input: string, pattern: string): boolean {
		const normalizedInput = normalize(input);
		const normalizedPattern = normalize(pattern);
		let escaped = normalizedPattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".");

		if (escaped.endsWith(" .*")) {
			escaped = `${escaped.slice(0, -3)}( .*)?`;
		}

		const flags = process.platform === "win32" ? "si" : "s";
		return new RegExp(`^${escaped}$`, flags).test(normalizedInput);
	}

	function normalize(value: string): string {
		return value.replaceAll("\\", "/");
	}
}
