import { createLocalBashOperations } from "../tools/bash.js";
import type { ExecutionService } from "./types.js";

export class LocalExecutionService implements ExecutionService {
	private readonly operations = createLocalBashOperations();

	getBashOperations() {
		return this.operations;
	}

	dispose(): void {}
}
