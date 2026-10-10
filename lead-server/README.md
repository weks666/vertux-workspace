# AI Lead Intelligence в Vertux Workspace

Модуль расширяет текущую таблицу `projects`, карточку CRM и импорт CSV/XLSX. Nexus остаётся control plane входа; сайты, исследования, материалы, очередь и расходы находятся в data plane Workspace. Владелец разрешил production-выпуск и выбрал личную подписку ChatGPT. [Порядок первого входа и ограничения](../docs/chatgpt-personal-connection.md). Статус конкретного выпуска фиксируется отдельным release-evidence.

## Как работает

1. Существующий импорт сохраняет компанию. Триггер Postgres создаёт единственную активную задачу Quick Scan; открытый браузер для обработки не нужен.
2. Quick Scan нормализует URL, проверяет публичные адреса и robots.txt, читает ограниченное число страниц, сохраняет цитаты, дату, уверенность, отрасль и объяснимый скоринг. LLM не вызывается.
3. По расписанию, по умолчанию 09:00 Europe/Moscow, планируется обновление устаревших компаний. После Quick выбираются наиболее перспективные доступные кандидаты Deep. Стартовые дневные пределы — 500 Quick и 50 Deep; считаются попытки, включая ошибки. Ручной Deep доступен при любом рейтинге в пределах тех же лимитов.
4. Deep расширяет исследование. Если AI включён и бюджет подтверждён, разрешённая модель выбирает услугу и основания из реально собранных сигналов. Свободные неподтверждённые утверждения модель не может записать в материалы. Текст компонуется из проверенных фактов, условных предложений и вопросов, затем редактируется менеджером.
5. Карточка содержит источники, скоринг, предложение, скрипт, email и follow-up черновики. Ручное добавление фактического ответа даёт классификацию, предлагаемый ответ и следующее действие. Отказ включает исключение из дальнейших коммуникаций и обработки.

В текущем репозитории подтверждены файловые импорты Rockefeller/2GIS. Добавлен общий CSV-адаптер для компаний. Отдельного API-адаптера Referral не обнаружено; ни один существующий источник не заменён. DB-триггер охватывает записи от всех импортёров.

## Данные и надёжность

- Миграция `supabase/migrations/20261010004715_workspace_lead_intelligence.sql` добавляет scoped settings, records, jobs, events, replies, usage и daily counters. Существующие компании, стадии, звонки и финансовые записи не переносятся.
- Postgres транзакционно выдаёт lease на задачу, ограничивает параллелизм и суточную квоту. Heartbeat продлевает lease. После перезапуска истёкшие lease возвращаются в ограниченный retry; старый worker не может сохранить результат. Настройки и очередь не хранятся в браузере.
- Изменение исходных данных компании отменяет устаревшую работу и создаёт новую проверку. Ручные тексты защищены optimistic revision и не затираются фоновым завершением.
- `workspace_private.current_role()` сверяет текущие серверные app_metadata, продукт, организацию и активность. API повторяет проверку на каждом запросе; SQL повторяет её для actor. Viewer читает, manager исследует и редактирует, owner/admin меняют бюджеты и удаляют исследования. Worker-RPC закрыт для `anon`/`authenticated`.
- Удаление исследования сохраняет CRM и финансовый журнал расхода. Удаляется содержимое исследования, материалов, ответов и заданий; tombstone предотвращает незаметное повторное исследование после удаления. Retention очищает старое содержимое по настройке, включая период паузы.
- Сводки компаний идут курсорными страницами; полные цитаты и материалы загружаются отдельно в карточке. Обновления используют серверное время и не теряются из-за часов клиентского ПК.

## Расходы

Для личного режима `aiProvider=chatgpt_plan` требуется отдельный вход SIWC владельца, разрешение OpenAI, модель из каталога аккаунта и явное включение AI. Запросы резервируются в Postgres по отдельному дневному лимиту `dailyPlanRequests`; это расход подписки, а не нулевая цена API. Неопределённые запросы также занимают слот. Фактические токены берутся из завершённого ответа; исчерпание лимита сохраняет отключение AI. Автоматического перехода на платный API нет.

OpenRouter остаётся отдельной опцией адаптера. Он требует отдельного ключа/конфигурации, включённого AI и положительных бюджетов; в личном production-режиме ключ не передаётся, бюджеты равны нулю.

Перед вызовом проверяются конечный лимит ключа, разрешённый model/provider и текущая цена. В Postgres атомарно резервируется верхняя оценка стоимости. После ответа сохраняется фактический `usage.cost` в целых USD nanounits (1 USD = 10⁹). Суточный лимит следует настроенному часовому поясу; лимит на компанию учитывает всю накопленную историю её расходов. Серверные потолки действуют дополнительно к настройкам UI.

Таймаут или неизвестный исход сохраняет резерв как неопределённый. Автоматический повтор той же AI-операции не происходит. Известная стоимость сохраняется даже при невалидном ответе или превышении оценки. Quick, классификация ответов и шаблонные материалы не расходуют LLM-токены. Если AI недоступен, источник и статус этого ограничения видны отдельно; шаблонный текст не помечается успешной AI-генерацией.

## Конфигурация сервера

Текущий операторский маршрут — [`scripts/lead-database-release.py`](../scripts/lead-database-release.py), затем [`scripts/lead-runtime-release.py`](../scripts/lead-runtime-release.py) на существующем DB-хосте с Supabase и Caddy. Требуется финансовая миграция от 8 октября. Node 24.15.0 и runtime-зависимости по lockfile собираются в Docker-образ; серверные файлы не входят в публичную раздачу Workspace.

Полный перечень без секретных значений: [`.env.example`](.env.example).

| Переменные | Назначение |
| --- | --- |
| `LEAD_ENABLED` | Запуск обработки; для активации `true` |
| `LEAD_SUPABASE_URL`, `LEAD_SUPABASE_ANON_KEY`, `LEAD_SUPABASE_SERVICE_KEY` | Существующий data plane и ключи только из серверного окружения |
| `LEAD_ORGANIZATION_ID`, `LEAD_PRODUCT_ID` | Проверенные scope UUID из существующего Nexus/Workspace |
| `LEAD_USAGE_SALT` | Отдельная приватная случайная строка минимум 32 символа; никогда не клиентский параметр |
| `LEAD_ORIGINS` | Точные HTTPS-origin интерфейса через запятую |
| `LEAD_PORT`, `LEAD_POLL_MS`, `LEAD_REQUESTS_PER_MINUTE` | Loopback порт, интервал worker, лимит запросов пользователя |
| `LEAD_OPENROUTER_KEY`, `LEAD_MAX_KEY_USD` | Опциональный ключ с конечным проверяемым лимитом и согласованный потолок ключа |
| `LEAD_ALLOWED_MODELS`, `LEAD_PROVIDER_NAME`, `LEAD_PROVIDER_SLUG` | Разрешённые сервером модели и upstream; по умолчанию существующий `openai/gpt-4.1-mini` / OpenAI |
| `LEAD_MAX_DAILY_USD`, `LEAD_MAX_COMPANY_USD` | Дополнительные долларовые потолки OpenRouter; 0 блокирует платный API, отдельно от лимита ChatGPT |
| `LEAD_CHATGPT_OWNER_ID`, `LEAD_CHATGPT_DIRECTORY`, `LEAD_CHATGPT_PORT` | Единственный существующий владелец личного Workspace, защищённые credentials и loopback OAuth-помощник на 47922 |
| `LEAD_MAX_DAILY_PLAN_REQUESTS` | Серверный потолок запросов подписки ChatGPT; текущий runtime задаёт 10 |
| `LEAD_BROWSER_IMAGE`, `LEAD_BROWSER_SECCOMP_PROFILE`, `LEAD_BROWSER_BROKER_SOCKET` | Закреплённый digest браузерного образа, host seccomp и сокет ограниченного broker; см. [инструкцию](../docs/lead-browser.md) |
| `LEAD_PSI_ENABLED`, `LEAD_PAGESPEED_KEY` | Необязательный PageSpeed; выключен по умолчанию |

При активации runtime-скрипт создаёт `/etc/vertux-lead-intelligence/service.env` и `browser.env` с правами 0600. Существующие ключи Supabase читаются только в памяти DB-хоста и передаются через приватный `--env-file`; в checkout, Pages и stdout они не копируются. Личный режим задаёт `aiProvider=chatgpt_plan`, `aiEnabled=false`, один worker, нулевые долларовые потолки и выключенный PageSpeed; `LEAD_OPENROUTER_KEY` не передаётся.

Node-контейнер `vertux-lead-intelligence` запускается как UID/GID 1000:1000, с read-only filesystem, снятыми capabilities, `no-new-privileges` и лимитами ресурсов. Он использует host network, но HTTP API и OAuth слушают только `127.0.0.1:47921` и `127.0.0.1:47922`. Записываемое состояние находится в `/var/lib/vertux-lead-intelligence`, смонтированном как `/state`; OAuth-records — в `/state/chatgpt` с правами 0700/0600.

Root-служба `vertux-lead-browser.service`, которую создаёт runtime-скрипт, принимает только фиксированный протокол через `/run/vertux-lead-browser/broker.sock`. Broker сам строит разрешённую Docker-команду с закреплённым image/seccomp, `--network=none` и sandbox; одновременно допускается один renderer. Node-контейнеру не передаётся `docker.sock`, право произвольного запуска Docker или секреты браузерному контейнеру.

`/health` проверяет только процесс; защищённое действие `health` также проверяет хранилище и права. Ни одно из них не подтверждает вход владельца или успешный ответ AI.

## Порядок разрешённого выпуска

Все команды выполняются из корня проверенного checkout с существующим SSH-доступом; `--key` принимает путь к приватному файлу, его содержимое не передаётся в чат. Наличие инструкции не заменяет разрешение на внешний выпуск.

1. **База и rehearsal receipt.** `python scripts/lead-database-release.py --host <DB-host> --key <SSH-key-path> --preflight` только читает состояние. Запуск без `--preflight` и `--apply` создаёт root-only backup на хосте, восстанавливает его в отдельную временную PostgreSQL-базу, проверяет миграцию, RLS, конкурентную выдачу задач и rollback, затем удаляет только временную базу. Содержимое backup и записи не скачиваются. Успех сохраняется в `evidence/lead-intelligence/database-rehearsal.json` и защищённом серверном receipt.
2. **Применение только по receipt.** Для ещё не применённой миграции тот же helper с `--apply --receipt evidence/lead-intelligence/database-rehearsal.json` требует совпадения локального и серверного receipt, hashes кандидата и исходного снимка. Применение транзакционное; результат сохраняется в `database-applied.json` и `/var/backups/vertux-workspace/lead-intelligence/applied-<receiptId>.json`. Если миграция уже применена, использовать существующий applied receipt; повторно запускать SQL вручную или обходить gate нельзя. Production rollback не автоматический: удаление новых таблиц требует отдельной проверки и сохранения накопленных lead-данных.
3. **Подготовка runtime.** `python scripts/lead-runtime-release.py --host <DB-host> --key <SSH-key-path>` по умолчанию загружает исходники в `/opt/vertux-lead-intelligence/releases/<bundle-prefix>`, сверяет hashes и собирает Node/browser images без запуска службы или изменения маршрута. Отдельного CLI-флага `--prepare` сейчас нет. Результат — `evidence/lead-intelligence/runtime-prepared.json`; закрытые build logs и резервная копия маршрута хранятся на хосте. Для существующего jump-подключения runtime-helper поддерживает `--jump-host` и `--jump-key`.
4. **Активация за Caddy.** Тот же runtime-helper с `--activate` требует ровно один applied DB receipt для точного hash миграции и одного действующего owner в нужном scope. Он отказывается автоматически заменять существующий runtime/broker. При старте очередь временно приостановлена, AI выключен. Helper поднимает ограниченный broker и Node-контейнер, проверяет локальный 401, синтетический JS-render и отсутствие прямого egress у браузера; затем добавляет только маршрут `/webhook/vertux-lead-intelligence` в существующий Caddy vhost `vertuxdb.duckdns.org`, валидирует и reload-ит Caddy. После HTTPS-проверок 401 без сессии и 403 для чужого Origin очередь снимается с паузы. Ошибка в этом этапе откатывает принадлежащий выпуску маршрут и runtime, но не миграцию БД.
5. **Frontend отдельно от сервера.** В [`data.js`](../data.js) уже задан `CONFIG.leadIntelligenceUrl = 'https://vertuxdb.duckdns.org/webhook/vertux-lead-intelligence'`. Это data-plane endpoint; переводить его на Nexus control-plane origin нельзя. Для Pages использовать [`scripts/publish-workspace-assets.py`](../scripts/publish-workspace-assets.py): `--prepare`, затем `--publish --receipt <prepared-receipt>`, после публикации `--verify --receipt <тот-же-receipt>`. Helper создаёт отдельное дерево `gh-pages` только из [`deploy/lead-workspace-assets.txt`](../deploy/lead-workspace-assets.txt) и `.nojekyll`; publish требует чистые committed assets, неизменившийся receipt и исходный HEAD, уже опубликованный в `origin/main`. Проверка сверяет HTTPS SHA-256 каждого ассета. Сервер, credentials, миграции и тесты в Pages не входят; checkout/index и CNAME helper не меняет. Исторический `prepare-managed-release.ps1` и ручной tar-архив не являются текущим путём публикации. Nexus Desktop и установщик этим изменением не заменяются.
6. **Вход владельца и приёмка.** После проверки runtime и опубликованных ассетов пройти обычные роли Workspace, импорт разрешённой компании, Quick/Deep без LLM и сохранение результатов. Для личного ChatGPT владелец запускает [`scripts/connect-workspace-chatgpt.ps1`](../scripts/connect-workspace-chatgpt.ps1): SSH туннелирует loopback 47922, публичный OAuth-маршрут не создаётся. После ручного входа отдельно проверить подключение, выбрать доступную модель и согласованный лимит, затем включить AI и проверить один разрешённый запрос. Успешный OAuth сам по себе AI не включает.

Файлы [`deploy/vertux-lead-intelligence.service`](../deploy/vertux-lead-intelligence.service) и [`deploy/lead-intelligence-route.conf`](../deploy/lead-intelligence-route.conf) — прежние иллюстративные шаблоны прямого Node/systemd и nginx; текущий release-helper их не устанавливает. Его systemd unit относится только к ограниченному browser broker, а HTTPS-маршрут обслуживает Caddy.

Ожидаемый receipt успешной активации называется `runtime-deployed.json` со статусом `DEPLOYED_AUTH_LOCKED_AI_OFF`; он не означает вход ChatGPT, вызов модели или приёмку UI владельцем. Эти результаты и Pages verification фиксируются отдельными evidence. Описание выше задаёт процедуру и не утверждает, что deployment уже завершён.

## Проверки

```powershell
npm.cmd ci
npm.cmd --prefix tests/lead-store-runtime ci
npm.cmd run check
npm.cmd test
node tests/verify-lead-ui.cjs
```

SQL-фикстуры используют закреплённый PGlite/Postgres в отдельной тестовой директории. Сетевые и provider-адаптеры заменяются синтетическими; тесты не читают production-credentials. UI launcher сам поднимает отдельный preview и блокирует все внешние запросы. Прежние сценарии `tests/verify-ui.cjs` запускаются с изолированным `tests/preview-server.mjs` и проверенными ассетами Service Center 1.2.3. Обычная статическая раздача Workspace использует рабочие настройки и не подходит для тестовых записей.

## Реальные границы

Отправка писем и синхронизация inbox отсутствуют в исходной системе и не подключены этим изменением. Доступны черновики, копирование, экспорт и ручной разбор ответа. Режим автоматической отправки API отвергает; включение ключа AI не разрешает отправку.

Поиск сайта использует импортированные адреса, контакты и доступные публичные ссылки. Внешний поисковый API не подключён. Нет обхода авторизации, CAPTCHA, robots или блокировок. Недоступный JS-renderer, закрытый сайт и недостаточные доказательства видны как ограничения. Обнаружение технологии по публичному коду — сигнал с уверенностью, а не полный технический аудит.

Источники контракта: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [database functions](https://supabase.com/docs/guides/database/functions), [OpenRouter usage](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [provider limits](https://openrouter.ai/docs/api_reference/limits). Реальная стоимость берётся из ответа провайдера, а не из заранее выдуманных цен.
