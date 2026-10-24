"""Publica um único XLSX sem usar o índice ou resolver merges do projeto."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess


class XlsxPublisher:
    def __init__(self, project: Path, state_dir: Path, remote="origin", branch="main"):
        self.project = project.resolve()
        self.repository = (state_dir / "publisher.git").resolve()
        self.branch = branch
        self.env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        for variable in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
            self.env.pop(variable, None)
        source = lambda *args: subprocess.run(["git", "-C", str(self.project), *args],
                                              check=True, capture_output=True, text=True).stdout.strip()
        source("check-ref-format", "refs/heads/" + branch)
        url = source("remote", "get-url", "--push", remote)
        self.repository.mkdir(parents=True, exist_ok=True)
        self.git("init", "--bare", str(self.repository))
        self.git("config", "remote.origin.url", url)
        for field in ("user.name", "user.email"):
            self.git("config", field, source("config", field))

    def git(self, *args, input=None, check=True):
        result = subprocess.run(["git", "--git-dir", str(self.repository), *args],
                                input=input, capture_output=True, env=self.env, timeout=180)
        if check and result.returncode:
            raise RuntimeError(f"Git {args[0]} falhou: {result.stderr.decode('utf-8', errors='replace').strip()}")
        return result

    def fetch(self):
        self.git("fetch", "--depth=1", "origin", "refs/heads/" + self.branch)
        return self.git("rev-parse", "FETCH_HEAD").stdout.decode().strip()

    def preflight(self):
        base = self.fetch()
        self.git("push", "--dry-run", "origin", f"{base}:refs/heads/{self.branch}")

    def publish(self, workbook: Path):
        workbook = workbook.resolve()
        relative = workbook.relative_to(self.project).as_posix()
        if workbook.suffix.lower() != ".xlsx" or not relative.startswith("analysis_output/"):
            raise ValueError("A publicação automática aceita somente XLSX de analysis_output/.")
        blob = self.git("hash-object", "-w", "--stdin", input=workbook.read_bytes()).stdout.decode().strip()
        for attempt in range(3):
            base = self.fetch()
            previous = self.git("rev-parse", f"{base}:{relative}", check=False)
            if previous.returncode == 0 and previous.stdout.decode().strip() == blob:
                return base  # A execução anterior pode ter enviado antes de ser interrompida.
            self.git("read-tree", base)
            self.git("update-index", "--add", "--cacheinfo", "100644", blob, relative)
            tree = self.git("write-tree").stdout.decode().strip()
            commit = self.git("commit-tree", tree, "-p", base,
                              input=f"analysis: salvar {relative}\n".encode()).stdout.decode().strip()
            result = self.git("push", "origin", f"{commit}:refs/heads/{self.branch}", check=False)
            if result.returncode == 0:
                return commit
            message = result.stderr.decode("utf-8", errors="replace")
            if attempt == 2 or not any(word in message for word in ("fetch first", "non-fast-forward", "stale info")):
                raise RuntimeError("Não foi possível enviar o XLSX ao GitHub: " + message.strip())
        raise RuntimeError("O branch remoto mudou repetidamente durante a publicação.")
