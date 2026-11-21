import argparse
import getpass
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys


SERVICE = "org.codex.telegram-bot"
ACCOUNT = "local-bot"
SECURITY = "/usr/bin/security"
HERE = Path(__file__).resolve().parent
BUNDLED_CODEX = Path("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")


def read_credentials():
    result = subprocess.run(
        [SECURITY, "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
        capture_output=True, text=True,
    )
    if result.returncode:
        return None
    credentials = json.loads(result.stdout)
    validate_credentials(credentials)
    return credentials


def validate_credentials(credentials):
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]{20,}", credentials.get("token", "")):
        raise ValueError("Проверь токен от BotFather.")
    if credentials.get("provider") not in ("yandex", "groq", "openrouter"):
        raise ValueError("Укажи yandex, groq или openrouter.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{20,512}", credentials.get("apiKey", "")):
        raise ValueError("Проверь ключ сервиса распознавания.")


def store_credentials(credentials):
    validate_credentials(credentials)
    # Send the password over stdin so it is absent from the process arguments.
    password = json.dumps(credentials, separators=(",", ":")).encode().hex()
    command = f"add-generic-password -U -s {SERVICE} -a {ACCOUNT} -X {password}\n"
    result = subprocess.run([SECURITY, "-q", "-i"], input=command, capture_output=True, text=True)
    if result.returncode or read_credentials() != credentials:
        raise RuntimeError("Не удалось сохранить ключи в Связке ключей macOS.")


def prompt_credentials():
    if not sys.stdin.isatty():
        raise RuntimeError("Для первого входа запусти установку ключей в Терминале.")
    token = getpass.getpass("Токен Telegram-бота: ").strip()
    provider = input("Сервис распознавания (Enter для yandex): ").strip().lower() or "yandex"
    key = getpass.getpass(f"Ключ {provider}: ").strip()
    return {"token": token, "provider": provider, "apiKey": key}


def launch(credentials, initial_project_id=None):
    node = shutil.which("node")
    codex = shutil.which("codex") or (str(BUNDLED_CODEX) if BUNDLED_CODEX.is_file() else None)
    if not node or not codex:
        raise RuntimeError("Для запуска нужны Node.js 22+ и Codex.")
    config = {
        **credentials,
        "codexPath": codex,
        "workspace": str(HERE.parent),
        "initialProjectId": initial_project_id,
    }
    return subprocess.run([node, str(HERE / "bot.mjs")], input=json.dumps(config), text=True).returncode


def main():
    parser = argparse.ArgumentParser(description="Личный бот Telegram для локального Codex.")
    parser.add_argument("--setup", action="store_true", help="Ввести и сохранить новые ключи.")
    parser.add_argument("--project-id", help="Открыть указанный локальный проект первым.")
    args = parser.parse_args()
    try:
        credentials = None if args.setup else read_credentials()
        if credentials is None:
            credentials = prompt_credentials()
            store_credentials(credentials)
        return launch(credentials, args.project_id)
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
