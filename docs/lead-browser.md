# Изолированный браузер исследования компаний

HTTP-проверка работает на Node 24 без браузера; серверные зависимости устанавливаются через `npm ci --omit=dev --ignore-scripts`. Для разбора HTML закреплён `htmlparser2@12.0.0`: потоковый парсер ограничивает обработку повреждённых страниц. JavaScript-сайт получает дополнительную проверку при настроенном `LEAD_BROWSER_IMAGE`. Если broker, Docker, образ или sandbox недоступны, результат содержит `RENDERER_UNAVAILABLE` или `BROWSER_FAILED`; незащищённого браузерного fallback нет.

Схема размещения выпуска от 2026-10-11: Node API и browser broker находятся на существующем сервере БД. API работает от пользователя `node` (UID/GID 1000). Его `/broker/docker` — адаптер [lead-docker-proxy.mjs](../deploy/lead-docker-proxy.mjs), который передаёт запрос в Unix socket `/run/vertux-lead-browser/broker.sock`. API-контейнер получает каталог этого socket через read-only bind mount; `docker.sock` и привилегированный Docker CLI ему не передаются.

Отдельный root-процесс [lead-browser-broker.py](../deploy/lead-browser-broker.py) имеет доступ к локальному Docker daemon. Broker проверяет точную форму разрешённых `run`/`rm`, самостоятельно составляет аргументы и допускает только закреплённый image и профиль seccomp. Произвольные команды, image, mounts, переменные окружения, сеть хоста и дополнительные privileges отклоняются. В Docker CLI передаётся фиксированное окружение без ключей API и конфигурации Docker registry. Очистка требует учтённого broker запуска и совпадения двух меток; удаляется проверенный immutable container ID.

В текущем развёртывании `LEAD_BROWSER_MAX_ACTIVE=1`. Один контейнер рендера получает `--network=none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, пользователя `pwuser`, 768 MiB памяти без дополнительного swap, один CPU, 128 процессов, отдельный `/dev/shm` 256 MiB и временный `/tmp` 192 MiB. Docker logging отключён. Broker ограничивает запрос запуска 8 KiB, строку протокола 3 MiB, входной поток 16 MiB, выходной поток 8 MiB и время рендера 45 секундами. EOF, отмена и превышение лимита завершают дочерний процесс и запускают ограниченную по времени очистку.

Образ использует Microsoft Playwright `v1.64.0-noble` и пакет `playwright@1.64.0`; версии должны совпадать. Администратор собирает образ заранее, затем закрепляет его локальный SHA-256 ID. Автоматическая загрузка при рендере запрещена (`--pull=never`). Пример подготовки из корня Workspace:

```sh
docker build -f deploy/Dockerfile.lead-browser -t vertux-lead-browser:1.64.0 .
docker image inspect --format '{{.Id}}' vertux-lead-browser:1.64.0
```

Конфигурация API и root broker должна ссылаться на один образ и один профиль:

| Переменная | Где задаётся | Значение |
| --- | --- | --- |
| `LEAD_BROWSER_IMAGE` | API и broker | Полученный `sha256:<64 hex>`; допустим также `repository@sha256:<64 hex>` |
| `LEAD_BROWSER_SECCOMP_PROFILE` | API и broker | `/etc/vertux-lead-intelligence/browser-seccomp.json` на хосте Docker |
| `LEAD_BROWSER_BROKER_SOCKET` | API и broker | `/run/vertux-lead-browser/broker.sock` |
| `LEAD_BROWSER_BROKER_GID` | broker | `1000` |
| `LEAD_BROWSER_MAX_ACTIVE` | broker | `1` |
| `PATH` | API | `/broker` перед обычными каталогами исполняемых файлов |

Broker создаёт каталог socket с владельцем `root:1000` и режимом `0750`, сам socket — `0660`. Исполняемый файл broker и профиль принадлежат root и недоступны API для записи. Профиль — обычный файл с запрещённой записью для группы/остальных и `defaultAction=SCMP_ACT_ERRNO`. API передаёт фиксированный путь профиля как часть проверяемого запроса; ему не нужен доступ к содержимому этого файла.

Chromium запускается с `chromiumSandbox: true`. Playwright блокирует downloads, service workers, WebSockets, дочерние окна и фреймы. Все HTTP-ресурсы проходят через JSON-line IPC: Node проверяет публичность адреса, robots.txt, лимиты, DNS и каждый redirect, затем получает ресурс с закреплённым IP. Docker `--network=none` ограничивает прямой сетевой доступ браузера независимо от обработчиков Playwright.

Хост должен поддерживать непривилегированные user namespaces. [Профиль Playwright v1.64.0](https://github.com/microsoft/playwright/blob/v1.64.0/utils/docker/seccomp_profile.json) уже разрешает нужные namespace-вызовы. В локальной копии [lead-browser-seccomp.json](../deploy/lead-browser-seccomp.json) 2026-10-11 изменено одно разрешение: у `chroot` удалено условие `includes.caps=[CAP_SYS_CHROOT]`, добавлен поясняющий комментарий. `--cap-drop=ALL` сохраняется. Оригинал, изменение, лицензия и оба хеша записаны в [THIRD-PARTY-NOTICES.md](../deploy/THIRD-PARTY-NOTICES.md).

Причина изменения: Chromium при ограничении файловой системы вызывает `sys_chroot("/proc/self/fdinfo/")`, затем меняет текущий каталог и завершает вспомогательный процесс. Это часть его namespace sandbox; исходники доступны в [Chromium credentials.cc](https://github.com/chromium/chromium/blob/main/sandbox/linux/services/credentials.cc). Условие upstream-профиля зависит от capabilities внешнего контейнера и при `--cap-drop=ALL` блокировало этот шаг.

Разрешение seccomp даёт ядру выполнить обычную проверку syscall. Linux по-прежнему проверяет `CAP_SYS_CHROOT` в текущем user namespace и LSM-политику; capabilities нового user namespace действуют в его границах. Внешнему контейнеру и хосту capability не добавляется. Это следует из [Linux chroot](https://github.com/torvalds/linux/blob/master/fs/open.c) и [Linux user namespaces](https://github.com/torvalds/linux/blob/master/kernel/user_namespace.c). Allow распространяется на весь syscall `chroot`: строковый путь seccomp BPF не проверяет. Поэтому сохранение остальных слоёв изоляции и проверка конкретного Docker-хоста обязательны; [документация Linux seccomp](https://docs.kernel.org/userspace-api/seccomp_filter.html) описывает фильтр как один из механизмов ограничения системных вызовов. `--no-sandbox`, privileged, host network, host IPC, добавление `SYS_ADMIN`/`SYS_CHROOT` и `seccomp=unconfined` в этой схеме запрещены.

Node API: `createBrowserRenderer({env})` возвращает `renderPage(url,{fetcher,checkUrl,signal,timeoutMs,maxBytes,maxRequests})`. Обычно API вызывать не нужно: `researchCompany()` включает renderer автоматически. `createResearcher({fetcher,renderer,now,env})` позволяет изолированные fixtures. `runRendererProtocol()` экспортирован для тестов IPC; production запускает его только в контейнере.

Поиск официального сайта использует адреса и контакты существующей карточки, кандидат из корпоративного email и явно подписанные публичные ссылки из `source_url`. Глобальный поисковый API не подключён. Совпадение короткого названия само по себе не подтверждает сайт: учитываются публичные контакты и местоположение. Лимит страниц включает все проверенные кандидаты, источник каталога и страницы контактов. Повторное использование quick-данных при deep-проверке сохраняет дату старейшего источника и не продлевает его срок актуальности; `analyzedAt` отдельно показывает время сборки исследования.

PageSpeed Insights включается отдельно переменной `LEAD_PSI_ENABLED=1`. Без этой переменной запросов Google нет. Необязательный `LEAD_PAGESPEED_KEY` передаётся только сервером в HTTP-заголовке к фиксированному endpoint Google, не в URL и не в результатах. Это одиночный лабораторный мобильный замер главной страницы при deep-проверке, а не утверждение о скорости всего сайта. Ошибки квоты/таймауты означают неизвестный результат. Платные AI-запросы этот модуль не выполняет.

Локальные проверки fixtures подтверждают протокол, ограничения fetch, robots, evidence, fallback и границу broker. `node --test tests/lead-browser-broker.test.mjs` включает Python-тесты с socket pairs и синтетическими дочерними процессами, без Docker. Они также сравнивают реальные аргументы `createBrowserRenderer` с грамматикой broker. Синтетический JS-тест в установленном локальном браузере проверяет IPC и выполнение JavaScript.

Приёмка production sandbox выполняется отдельно на сервере БД с закреплённым образом и указанным хешем профиля: Chromium должен реально выполнить синтетическую JS-страницу, запуск сохраняет sandbox и ограничения контейнера, прямые DNS/HTTP-соединения из контейнера должны завершаться неуспешно. После завершения не должны оставаться рендер-контейнеры. В [runtime-deployed.json](../evidence/lead-intelligence/runtime-deployed.json) за 2026-10-11 (МСК) зафиксирован успешный серверный тест синтетической JS-страницы: `rendered=true`, один запрос через IPC, `isolation=docker_network_none`, `sandbox=true`, `directEgressBlocked=true`, `dockerSocketShared=false`. Это подтверждение данного сценария на production-хосте; доступность и корректность произвольных внешних сайтов этим тестом не установлены.

Источники: [Node HTTP](https://nodejs.org/api/http.html#httprequestoptions-callback), [Node DNS](https://nodejs.org/api/dns.html), [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html), [Playwright routing](https://playwright.dev/docs/network), [Google API key headers](https://docs.cloud.google.com/apis/docs/system-parameters), [PageSpeed Insights](https://developers.google.com/speed/docs/insights/v5/get-started).
