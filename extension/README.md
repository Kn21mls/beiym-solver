# Beyim Solver — браузерное расширение

Расширение считывает задание на Beyim и предлагает решение с помощью Groq. Версии для Firefox, Chromium и Safari используют личный ключ Groq напрямую; запуск локального сервера им не нужен. При разборе текст задания, варианты и при необходимости изображение отправляются в Groq. Ключ сохраняется в локальном хранилище расширения; не включайте его в архивы или репозиторий.

## Сборка

Установите Node.js 24, затем в папке `extension`:

```bash
npm ci
npm run typecheck
npm test
npm run package:chromium
npm run package:firefox
npm run package:safari:groq
```

Команды создают папки `chromium/`, `firefox/`, `safari/web-extension/` и отдельные ZIP-архивы. Они предназначены для локальной проверки и не подписаны магазинами.

## Установка

- **Chrome, Edge, Brave, Opera, Vivaldi и другие настольные Chromium-браузеры:** откройте страницу расширений, включите режим разработчика и выберите «Загрузить распакованное расширение», указав папку `chromium/`. В Chrome это `chrome://extensions`, в Edge — `edge://extensions`. Поддержка конкретных версий браузеров, кроме проверенного Chromium, требует отдельной проверки.
- **Firefox 142+:** откройте `about:debugging#/runtime/this-firefox`, нажмите «Загрузить временное дополнение» и выберите `firefox/manifest.json`. Установка временная, до закрытия Firefox. Постоянная установка в обычном Firefox требует подписи Mozilla.
- **Safari 18.4+ на macOS:** используйте `safari/web-extension/` для создания приложения расширения через `xcrun safari-web-extension-packager` и Xcode или Apple Web Extension Packager. Для распространения потребуются соответствующие подпись и публикация Apple. На Linux Safari не проверен.

После установки откройте страницу Beyim, нажмите значок расширения, подключите Groq и подтвердите передачу данных. Обновите вкладку Beyim после установки, если она была открыта раньше.

Полезные инструкции: [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world), [Edge](https://learn.microsoft.com/microsoft-edge/extensions/getting-started/extension-sideloading), [Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/), [Safari](https://developer.apple.com/documentation/safariservices/packaging-a-safari-web-extension).
