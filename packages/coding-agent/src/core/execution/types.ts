import type { BashOperations } from "../tools/bash.js";

export interface ExecutionService {
	getBashOperations(): BashOperations;
	dispose(): Promise<void> | void;
}
