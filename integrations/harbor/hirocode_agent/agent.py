from __future__ import annotations

import json
import os
import shlex
from pathlib import Path, PurePosixPath
from typing import Final

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

HIROCODE_PACKAGE_NAME: Final = "@hirocode/coding-agent"
HIROCODE_BINARY_NAME: Final = "hirocode"
PROMPTS_SOURCE_DIR_NAME: Final = "prompts"
AUTO_BUNDLE_ENV_VAR: Final = "HIROCODE_HARBOR_BUNDLE_DIR"

INSTALL_ROOT: Final = PurePosixPath("/installed-agent")
PROMPTS_DEST_DIR: Final = INSTALL_ROOT / PROMPTS_SOURCE_DIR_NAME
INSTRUCTION_FILE_PATH: Final = INSTALL_ROOT / "instruction.md"
VERIFICATION_FILE_PATH: Final = PROMPTS_DEST_DIR / "verification-pass.md"
BENCHMARK_PROMPT_PATH: Final = PROMPTS_DEST_DIR / "terminal-bench-system.md"
BENCHMARK_BUNDLE_DEST_DIR: Final = INSTALL_ROOT / "benchmark-bundle"
BENCHMARK_BUNDLE_ENTRYPOINT: Final = BENCHMARK_BUNDLE_DEST_DIR / "index.ts"
HIROCODE_AGENT_HOME: Final = EnvironmentPaths.agent_dir / "hirocode-home"

FORWARDED_ENV_PREFIXES: Final[tuple[str, ...]] = (
    "ANTHROPIC_",
    "OPENAI_",
    "AZURE_OPENAI_",
    "GOOGLE_",
    "GEMINI_",
    "GROQ_",
    "CEREBRAS_",
    "XAI_",
    "OPENROUTER_",
    "AI_GATEWAY_",
    "ZAI_",
    "MISTRAL_",
    "MINIMAX_",
    "OPENCODE_",
    "KIMI_",
    "AWS_",
    "VERTEX_",
)

FORWARDED_ENV_EXACT: Final[frozenset[str]] = frozenset(
    {
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    }
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _local_coding_agent_version(repo_root: Path) -> str | None:
    package_json_path = repo_root / "packages" / "coding-agent" / "package.json"
    if not package_json_path.exists():
        return None

    with package_json_path.open("r", encoding="utf-8") as handle:
        package_json = json.load(handle)

    version = package_json.get("version")
    return version if isinstance(version, str) and version else None


def _forwarded_environment() -> dict[str, str]:
    forwarded: dict[str, str] = {}
    for key, value in os.environ.items():
        if not value:
            continue
        if key in FORWARDED_ENV_EXACT or key.startswith(FORWARDED_ENV_PREFIXES):
            forwarded[key] = value
    return forwarded


def _resolve_bundle_source_dir(
    repo_root: Path, bundle_source_dir: Path | str | None
) -> Path | None:
    if bundle_source_dir is None:
        env_override = os.environ.get(AUTO_BUNDLE_ENV_VAR)
        candidate = (
            Path(env_override)
            if env_override
            else repo_root / "integrations" / "harbor" / "benchmark_bundle"
        )
    else:
        candidate = Path(bundle_source_dir)

    if not candidate.exists():
        if bundle_source_dir is not None or os.environ.get(AUTO_BUNDLE_ENV_VAR):
            raise FileNotFoundError(
                f"Benchmark bundle directory not found: {candidate}"
            )
        return None

    entrypoint = candidate / "index.ts"
    if not entrypoint.exists():
        if bundle_source_dir is not None or os.environ.get(AUTO_BUNDLE_ENV_VAR):
            raise FileNotFoundError(
                f"Benchmark bundle entrypoint not found: {entrypoint}"
            )
        return None

    return candidate


def _quote_cli_args(args: list[str]) -> str:
    return " ".join(shlex.quote(arg) for arg in args)


class HirocodeInstalledAgent(BaseInstalledAgent):
    """Run hirocode in Harbor without coupling benchmark behavior to the interactive CLI."""

    SUPPORTS_ATIF = False

    def __init__(
        self,
        logs_dir: Path,
        *args,
        bundle_source_dir: Path | str | None = None,
        version: str | None = None,
        **kwargs,
    ) -> None:
        self._repo_root = _repo_root()
        self._bundle_source_dir = _resolve_bundle_source_dir(
            self._repo_root, bundle_source_dir
        )
        resolved_version = version or _local_coding_agent_version(self._repo_root)
        super().__init__(logs_dir, *args, version=resolved_version, **kwargs)

    @staticmethod
    def name() -> str:
        return "hirocode"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).with_name("install-hirocode.sh.j2")

    @property
    def _prompts_source_dir(self) -> Path:
        return Path(__file__).with_name(PROMPTS_SOURCE_DIR_NAME)

    def get_version_command(self) -> str | None:
        return "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; hirocode --version"

    def parse_version(self, stdout: str) -> str:
        for line in stdout.splitlines():
            text = line.strip()
            if text:
                return text
        return stdout.strip()

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        await environment.exec(
            command=f"mkdir -p {shlex.quote(PROMPTS_DEST_DIR.as_posix())}"
        )
        await environment.upload_dir(
            self._prompts_source_dir, PROMPTS_DEST_DIR.as_posix()
        )

        if self._bundle_source_dir is not None:
            await environment.exec(
                command=f"mkdir -p {shlex.quote(BENCHMARK_BUNDLE_DEST_DIR.as_posix())}"
            )
            await environment.upload_dir(
                self._bundle_source_dir, BENCHMARK_BUNDLE_DEST_DIR.as_posix()
            )

    def _runtime_env(self) -> dict[str, str]:
        env = _forwarded_environment()
        env.update(
            {
                "HIROCODE_CODING_AGENT_DIR": HIROCODE_AGENT_HOME.as_posix(),
                "PI_CODING_AGENT_DIR": HIROCODE_AGENT_HOME.as_posix(),
                "HIROCODE_SKIP_VERSION_CHECK": "1",
                "PI_SKIP_VERSION_CHECK": "1",
            }
        )
        return env

    def _base_cli_args(self) -> list[str]:
        if not self.model_name:
            raise ValueError(
                "HirocodeInstalledAgent requires Harbor to provide a model name"
            )

        args = [
            HIROCODE_BINARY_NAME,
            "--print",
            "--model",
            self.model_name,
            "--append-system-prompt",
            BENCHMARK_PROMPT_PATH.as_posix(),
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
        ]

        if self._bundle_source_dir is not None:
            args.extend(["--extension", BENCHMARK_BUNDLE_ENTRYPOINT.as_posix()])

        return args

    def _write_instruction_command(self, instruction: str) -> str:
        terminator = "__HIROCODE_HARBOR_INSTRUCTION__"
        return (
            f"cat > {shlex.quote(INSTRUCTION_FILE_PATH.as_posix())} <<'{terminator}'\n"
            f"{instruction}\n"
            f"{terminator}"
        )

    def _initial_run_command(self, instruction: str) -> str:
        cli_args = self._base_cli_args()
        cli_args.append(f"@{INSTRUCTION_FILE_PATH.as_posix()}")
        return f"{self._write_instruction_command(instruction)}\n{_quote_cli_args(cli_args)}"

    def _verification_run_command(self) -> str:
        cli_args = self._base_cli_args()
        cli_args.append("--continue")
        cli_args.append(f"@{VERIFICATION_FILE_PATH.as_posix()}")
        return _quote_cli_args(cli_args)

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        env = self._runtime_env()
        return [
            ExecInput(
                command=self._initial_run_command(instruction),
                cwd="/app",
                env=env,
            ),
            ExecInput(
                command=self._verification_run_command(),
                cwd="/app",
                env=env,
            ),
        ]

    def populate_context_post_run(self, context: AgentContext) -> None:
        session_root = self.logs_dir / "hirocode-home"
        metadata = dict(context.metadata or {})
        metadata.update(
            {
                "agent": self.name(),
                "session_root": str(session_root),
                "benchmark_bundle_loaded": self._bundle_source_dir is not None,
            }
        )
        context.metadata = metadata
