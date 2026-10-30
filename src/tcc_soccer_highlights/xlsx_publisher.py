"""Publica um único XLSX sem usar o índice ou resolver merges do projeto."""
from __future__ import annotations

import os
import logging
from pathlib import Path
import subprocess
import time


LOG = logging.getLogger(__name__)
NETWORK_TIMEOUT = 300
NETWORK_ATTEMPTS = 4
RETRY_DELAYS = (5, 15, 30)


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

    def git(self, *args, input=None, check=True, timeout=180):
        result = subprocess.run(["git", "--git-dir", str(self.repository), *args],
                                input=input, capture_output=True, env=self.env, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f"Git {args[0]} falhou: {result.stderr.decode('utf-8', errors='replace').strip()}")
        return result

    def network(self, *args, check=True):
        """Repete falhas transitórias; rejeições de acesso/merge continuam explícitas."""
        transient = ("could not resolve host", "failed to connect", "couldn't connect", "timed out",
                     "connection reset", "connection was reset", "connection closed", "early eof",
                     "remote end hung up", "unexpected disconnect", "rpc failed", "tls connection",
                     "ssl_connect", "schannel: failed", "returned error: 429", "returned error: 500",
                     "returned error: 502", "returned error: 503", "returned error: 504")
        for attempt in range(NETWORK_ATTEMPTS):
            try:
                result = self.git(*args, check=False, timeout=NETWORK_TIMEOUT)
            except subprocess.TimeoutExpired as exc:
                if attempt == NETWORK_ATTEMPTS - 1:
                    raise RuntimeError(f"GitHub: {args[0]} excedeu {NETWORK_TIMEOUT} s em "
                                       f"{NETWORK_ATTEMPTS} tentativas. O XLSX local foi preservado para retomada.") from exc
                reason = f"tempo limite de {NETWORK_TIMEOUT} s"
            else:
                if result.returncode == 0:
                    return result
                message = result.stderr.decode("utf-8", errors="replace").strip()
                retry = any(term in message.lower() for term in transient)
                if not retry or attempt == NETWORK_ATTEMPTS - 1:
                    if check:
                        raise RuntimeError(f"GitHub: {args[0]} falhou: {message}")
                    return result
                reason = message
            delay = RETRY_DELAYS[attempt]
            LOG.warning("GitHub: falha temporária em %s (%s). Tentativa %d/%d; repetindo em %d s.",
                        args[0], reason, attempt + 1, NETWORK_ATTEMPTS, delay)
            time.sleep(delay)

    def fetch(self):
        remote = self.network("ls-remote", "--exit-code", "origin", "refs/heads/" + self.branch)
        tip = remote.stdout.decode().split()[0]
        # Depois de um push bem-sucedido, já temos o commit e sua árvore completos.
        # Consultar a ponta é suficiente; só transferir quando houver dados novos.
        if self.git("cat-file", "-e", tip + "^{commit}", check=False).returncode:
            self.network("fetch", "--depth=1", "origin", "refs/heads/" + self.branch)
            tip = self.git("rev-parse", "FETCH_HEAD").stdout.decode().strip()
        self.git("update-ref", "refs/heads/published", tip)
        return tip

    def preflight(self):
        base = self.fetch()
        self.network("push", "--dry-run", "origin", f"{base}:refs/heads/{self.branch}")

    def publish(self, workbook: Path):
        workbook = workbook.resolve()
        relative = workbook.relative_to(self.project).as_posix()
        if workbook.suffix.lower() != ".xlsx" or not relative.startswith("analysis_output/"):
            raise ValueError("A publicação automática aceita somente XLSX de analysis_output/.")
        blob = self.git("hash-object", "-w", "--stdin", input=workbook.read_bytes()).stdout.decode().strip()
        LOG.info("GitHub: publicando %s", relative)
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
            result = self.network("push", "origin", f"{commit}:refs/heads/{self.branch}", check=False)
            if result.returncode == 0:
                self.git("update-ref", "refs/heads/published", commit)
                return commit
            message = result.stderr.decode("utf-8", errors="replace")
            if attempt == 2 or not any(word in message for word in ("fetch first", "non-fast-forward", "stale info")):
                raise RuntimeError("Não foi possível enviar o XLSX ao GitHub: " + message.strip())
        raise RuntimeError("O branch remoto mudou repetidamente durante a publicação.")
