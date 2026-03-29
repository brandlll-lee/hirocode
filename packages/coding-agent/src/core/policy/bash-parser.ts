import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);

export interface ParsedBashInvocation {
	text: string;
	tokens: string[];
}

export interface ParsedBashCommand {
	invocations: ParsedBashInvocation[];
	pipes: boolean;
	redirects: string[];
	subcommands: string[];
	backgrounded: boolean;
	chained: string[];
}

let parserPromise: Promise<Parser | null> | undefined;

function resolveAsset(specifier: string): string {
	return require.resolve(specifier);
}

async function getParser(): Promise<Parser | null> {
	if (!parserPromise) {
		parserPromise = createParser();
	}
	return parserPromise;
}

async function createParser(): Promise<Parser | null> {
	try {
		await Parser.init({
			locateFile() {
				return resolveAsset("web-tree-sitter/web-tree-sitter.wasm");
			},
		});
		const language = await Language.load(resolveAsset("tree-sitter-bash/tree-sitter-bash.wasm"));
		const parser = new Parser();
		parser.setLanguage(language);
		return parser;
	} catch {
		return null;
	}
}

export async function parseBashCommand(command: string): Promise<ParsedBashCommand | null> {
	const parser = await getParser();
	if (!parser) {
		return null;
	}

	const tree = parser.parse(command);
	if (!tree) {
		return null;
	}

	try {
		const result: ParsedBashCommand = {
			invocations: [],
			pipes: false,
			redirects: [],
			subcommands: [],
			backgrounded: false,
			chained: [],
		};

		walkNode(tree.rootNode, result, false);
		return result;
	} finally {
		tree.delete();
	}
}

function walkNode(node: Node, result: ParsedBashCommand, inSubcommand: boolean): void {
	switch (node.type) {
		case "command": {
			const tokens = collectCommandTokens(node);
			if (!inSubcommand && tokens.length > 0) {
				const text = node.parent?.type === "redirected_statement" ? node.parent.text : node.text;
				result.invocations.push({ text, tokens });
			}
			break;
		}

		case "command_name": {
			if (inSubcommand) {
				result.subcommands.push(node.text);
			}
			break;
		}

		case "pipeline": {
			result.pipes = true;
			break;
		}

		case "command_substitution": {
			for (let index = 0; index < node.childCount; index++) {
				const child = node.child(index);
				if (child) {
					walkNode(child, result, true);
				}
			}
			return;
		}

		case "list": {
			for (let index = 0; index < node.childCount; index++) {
				const child = node.child(index);
				if (!child) {
					continue;
				}
				if (child.type === "&&" || child.type === "||") {
					result.chained.push(child.type);
				}
				walkNode(child, result, inSubcommand);
			}
			return;
		}

		case "file_redirect":
		case "redirected_statement": {
			for (let index = 0; index < node.childCount; index++) {
				const child = node.child(index);
				if (!child) {
					continue;
				}
				if (child.type === "word" && index > 0) {
					result.redirects.push(child.text);
				}
				walkNode(child, result, inSubcommand);
			}
			return;
		}
	}

	if (node.type === "&") {
		result.backgrounded = true;
	}

	for (let index = 0; index < node.childCount; index++) {
		const child = node.child(index);
		if (child) {
			walkNode(child, result, inSubcommand);
		}
	}
}

function collectCommandTokens(node: Node): string[] {
	const tokens: string[] = [];
	for (let index = 0; index < node.childCount; index++) {
		const child = node.child(index);
		if (!child) {
			continue;
		}
		if (
			child.type !== "command_name" &&
			child.type !== "word" &&
			child.type !== "string" &&
			child.type !== "raw_string" &&
			child.type !== "concatenation"
		) {
			continue;
		}
		tokens.push(child.text);
	}
	return tokens;
}
