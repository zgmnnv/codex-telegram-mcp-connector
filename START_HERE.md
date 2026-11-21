# Подключить личного бота к Codex

Нужны Mac, Node.js 22+, Python 3 и установленный Codex с входом в свой аккаунт. Для меню нужны локальные методы Codex `project/list` и `project/create`. Проверено на Codex CLI 0.169.1.

1. Создай своего бота у [BotFather](https://core.telegram.org/bots/tutorial#obtain-your-bot-token). Для голосовых подготовь один ключ [Яндекс SpeechKit](https://aistudio.yandex.ru/en/docs/speechkit/concepts/auth), Groq или OpenRouter.
2. Из корня репозитория выполни `python3 codex-bot/start.py` и введи ключи в Терминале. Они сохранятся в Связке ключей macOS. Для замены ключей добавь флаг `--setup`.
3. Открой личный чат с ботом и отправь команду `/start` с кодом из Терминала. Затем открой `/menu` и выбери активный чат.

Оставь Мак и Терминал активными, пока нужен бот. При следующих запусках ключи и привязка используются повторно.
