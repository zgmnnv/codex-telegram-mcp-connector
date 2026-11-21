"""Check staged text and paths for common credentials and local data."""
from pathlib import PurePosixPath
import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(["git", *args])


PATTERNS = [
    rb"\b[0-9]{6,}:[A-Za-z0-9_-]{28,}\b",
    rb"\b(?:gsk_|sk-or-v[0-9]+-|AQVN)[A-Za-z0-9_-]{24,}\b",
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    rb"/Users/[^/\s]+/(?:Documents|Desktop|Downloads|Library|\.codex)\b",
]


def staged_match(path):
    parts = PurePosixPath(path).parts
    filename = parts[-1]
    if any(part in ("private", "sessions") for part in parts):
        return True
    if filename.startswith(".env") or filename.endswith((".session", ".db", ".sqlite", ".log")):
        return True
    payload = git("show", ":" + path)
    return any(re.search(pattern, payload) for pattern in PATTERNS)


def main():
    for name in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"):
        identity = git("var", name)
        match = re.search(rb"<([^<>]+)>", identity)
        if not match or not match.group(1).lower().endswith(b"@users.noreply.github.com"):
            print("Настрой GitHub noreply для автора и коммитера этого репозитория.")
            return 1
    changed = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").decode().split("\0")
    blocked = sum(staged_match(path) for path in changed if path)
    if blocked:
        print(f"Проверка остановлена: подозрительные данные в {blocked} файлах.")
        return 1
    print("Проверка добавленных файлов пройдена.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
