export namespace BashArity {
	export function prefix(tokens: string[]): string[] {
		for (let length = tokens.length; length > 0; length--) {
			const candidate = tokens.slice(0, length).join(" ");
			const arity = ARITY[candidate];
			if (arity !== undefined) {
				return tokens.slice(0, arity);
			}
		}

		if (tokens.length === 0) {
			return [];
		}

		return tokens.slice(0, 1);
	}

	const ARITY: Record<string, number> = {
		cat: 1,
		cd: 1,
		chmod: 1,
		chown: 1,
		cp: 1,
		echo: 1,
		env: 1,
		export: 1,
		git: 2,
		"git config": 3,
		"git remote": 3,
		"git stash": 3,
		grep: 1,
		kill: 1,
		killall: 1,
		ln: 1,
		ls: 1,
		mkdir: 1,
		mv: 1,
		npm: 2,
		"npm exec": 3,
		"npm init": 3,
		"npm run": 3,
		"npm view": 3,
		pnpm: 2,
		"pnpm dlx": 3,
		"pnpm exec": 3,
		"pnpm run": 3,
		ps: 1,
		pwd: 1,
		python: 2,
		rm: 1,
		rmdir: 1,
		sleep: 1,
		source: 1,
		tail: 1,
		touch: 1,
		unset: 1,
		which: 1,
		yarn: 2,
		"yarn dlx": 3,
		"yarn run": 3,
	};
}
