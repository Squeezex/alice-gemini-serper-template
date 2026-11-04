# Яндекс Алиса + Gemini (+ Serper) на Amvera

Готовый вебхук для навыка Яндекс Алисы. Основной сценарий — деплой в [Amvera Cloud](https://amvera.ru/) с ответами через **Gemini API**. Опционально: поиск через Serper и запасной провайдер Grok. Совместимость с Netlify/Vercel сохранена.

## Развёртывание на Amvera

1. Создайте приложение в [Amvera](https://amvera.ru/) (тип — обычное приложение / Node.js).
2. Загрузите код: через Git (`git push`), привязку GitHub или загрузку файлов в интерфейсе.
3. В корне уже есть `amvera.yml` — сборка пропускается (зависимостей нет), запуск: `node server.js` на порту `80`.
4. Откройте вкладку **Переменные** и добавьте секреты:
   - `GEMINI_API_KEY` — ключ из [Google AI Studio](https://aistudio.google.com/app/apikey)
   - `AI_PROVIDER` — значение `gemini`
   - `SERPER_API_KEY` — по желанию, для поиска в интернете
   - `GEMINI_MODEL` — по желанию (по умолчанию `gemini-3.5-flash-lite`)
5. Перезапустите контейнеры после добавления переменных (на этапе сборки переменные недоступны).
6. Во вкладке **Домены** добавьте бесплатный домен Amvera с типом **HTTPS**.
7. Webhook URL для Яндекс Диалогов:

   `https://ВАШ-ДОМЕН.amvera.tech/api`

   (точный вид домена смотрите во вкладке «Домены»; раньше также встречался формат `*.amvera.io`).
8. В настройках навыка включите **Использовать хранилище данных в навыке**, чтобы сохранять контекст между репликами.

Проверка здоровья: откройте `https://ВАШ-ДОМЕН/api` в браузере — должен вернуться JSON `{"ok":true,...}`.

Документация Amvera: [быстрый старт](https://docs.amvera.ru/applications/quick-start.html), [Node.js Server](https://docs.amvera.ru/applications/environments/nodejs-server.html), [переменные](https://docs.amvera.ru/applications/configuration/variables.html), [сети и домены](https://docs.amvera.ru/applications/configuration/network.html).

## Какие ключи нужны

- **GEMINI_API_KEY** — обязателен для ответов нейросети.
- **SERPER_API_KEY** — включает поиск. Без него обычные ответы Gemini работают, поиск недоступен.
- **GEMINI_MODEL** — необязателен. По умолчанию `gemini-2.5-flash-lite` (быстрая, без thinking). Для Алисы на Amvera **не ставьте** `gemini-3.5-*` / Pro: thinking часто не укладывается в 4.5 с.
- **AI_PROVIDER** — `gemini` (рекомендуется), `auto` или `grok`.
- **GROK_API_KEY** / **XAI_API_KEY** — только если нужен Grok.

Ключи храните только в секретах Amvera (или env Netlify/Vercel). Не коммитьте их в Git.

## Локальный запуск

```bash
export GEMINI_API_KEY=ваш_ключ
export AI_PROVIDER=gemini
export PORT=3000
node server.js
```

Затем откройте `http://127.0.0.1:3000/api` и отправьте POST на тот же путь (как делает Алиса).

Тесты: `npm test`.

## Подключение к Яндекс Диалогам

1. Создайте навык в [Яндекс Диалогах](https://dialogs.yandex.ru/).
2. Backend → Webhook URL → `https://ВАШ-ДОМЕН/api`.
3. Тип доступа: **Приватный**, включите тестирование.
4. Скажите: «Алиса, запусти навык [имя]» или проверьте во вкладке **Тестирование**.

Алиса ждёт ответ примерно за **4.5 секунды** — в коде уже есть таймауты под этот лимит.

## Структура проекта

| Файл | Назначение |
|------|------------|
| `server.js` | HTTP-сервер для Amvera / локального запуска |
| `amvera.yml` | Конфиг сборки и запуска Amvera |
| `api/index.js` | Логика вебхука Алисы + Gemini/Serper |
| `netlify/functions/alice.js` | Адаптер для Netlify Functions |
| `vercel.json` | Настройки Vercel |

## Netlify / Vercel (опционально)

Если деплоите не на Amvera:

- **Netlify** — импорт репозитория, env-переменные, webhook = `https://SITE.netlify.app/api`
- **Vercel** — тот же `api/index.js`, webhook = `https://SITE.vercel.app/api`
