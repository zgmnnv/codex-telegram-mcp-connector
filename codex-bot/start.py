import argparse
import getpass
import json
import os
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
    if credentials.get("provider", "yandex") != "yandex":
        raise ValueError("Введи ключ Яндекс SpeechKit через --setup.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{20,512}", credentials.get("apiKey", "")):
        raise ValueError("Проверь ключ Яндекс SpeechKit.")


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
    key = getpass.getpass("Ключ Яндекс SpeechKit: ").strip()
    return {"token": token, "apiKey": key}


def open_desktop():
    try:
        state = json.loads((HERE / "private" / "shared-server.json").read_text())
        socket = Path(state["socket"])
        parent = socket.parent.stat()
    except (OSError, ValueError, KeyError, TypeError):
        raise RuntimeError("Сначала запусти бота с параметром --shared.")
    if not socket.is_socket() or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise RuntimeError("Локальный сокет общего App Server недоступен.")
    if subprocess.run(["/usr/bin/pgrep", "-x", "ChatGPT"], capture_output=True).returncode == 0:
        raise RuntimeError("Выйди из Codex через ⌘Q перед подключением к общему серверу.")
    endpoint = f"ws+unix://localhost{socket}:/rpc"
    return subprocess.run(["/usr/bin/open", "-b", "com.openai.codex", "--env", f"CODEX_APP_SERVER_WS_URL={endpoint}"]).returncode


def launch(credentials, shared=False):
    node = shutil.which("node")
    codex = shutil.which("codex") or (str(BUNDLED_CODEX) if BUNDLED_CODEX.is_file() else None)
    if not node or not codex:
        raise RuntimeError("Для запуска нужны Node.js 22+ и Codex.")
    config = {
        "token": credentials["token"],
        "apiKey": credentials["apiKey"],
        "codexPath": codex,
        "workspace": str(HERE.parent),
        "shared": shared,
    }
    return subprocess.run([node, str(HERE / "bot.mjs")], input=json.dumps(config), text=True).returncode


def main():
    parser = argparse.ArgumentParser(description="Личный бот Telegram для локального Codex.")
    parser.add_argument("--setup", action="store_true", help="Ввести и сохранить новые ключи.")
    parser.add_argument("--shared", action="store_true", help="Запустить App Server для Codex Desktop.")
    parser.add_argument("--desktop", action="store_true", help="Открыть Codex Desktop с общим App Server.")
    args = parser.parse_args()
    try:
        if args.desktop:
            return open_desktop()
        credentials = None if args.setup else read_credentials()
        if credentials is None:
            credentials = prompt_credentials()
            store_credentials(credentials)
        return launch(credentials, args.shared)
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
