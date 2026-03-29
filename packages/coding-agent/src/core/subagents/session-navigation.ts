export type ChildSessionOpenMode = "attach" | "detached";

export function resolveChildSessionOpenMode(options: {
	isStreaming: boolean;
	activeSessionFile?: string;
	targetSessionFile: string;
}): ChildSessionOpenMode {
	if (options.isStreaming && options.activeSessionFile && options.targetSessionFile !== options.activeSessionFile) {
		return "detached";
	}
	return "attach";
}
