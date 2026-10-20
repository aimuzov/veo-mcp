<p align="center">
	<a href="README.md"><img src="https://img.shields.io/badge/English-555?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI+PGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg+PHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjQzgxMDJFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNDODEwMkUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg==" alt="English"></a>
	<img src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-8b5cf6?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5IDYiPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0wIDBoOXYzSDB6Ii8+PHBhdGggZmlsbD0iIzAwMzlhNiIgZD0iTTAgMmg5djJIMHoiLz48cGF0aCBmaWxsPSIjZDUyYjFlIiBkPSJNMCA0aDl2MkgweiIvPjwvc3ZnPg==" alt="Русский">
</p>

<p align="center">
	<a href="https://github.com/aimuzov/veo-mcp/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/aimuzov/veo-mcp/check.yml?branch=main&label=check" alt="Check"></a>
	<a href="package.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Faimuzov%2Fveo-mcp%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&logo=nodedotjs&logoColor=white&color=5fa04e" alt="Node"></a>
	<a href="LICENSE"><img src="https://img.shields.io/github/license/aimuzov/veo-mcp" alt="License"></a>
</p>

<h3 align="center">Google Veo как инструмент MCP</h3>
<p align="center">Видео из текста и из картинки через Gemini API, MP4 на диске</p>

Небольшой MCP-сервер, который даёт Claude Code, Claude Desktop или любому другому MCP-клиенту инструмент
`generate_video` на Google Veo. Ходит в REST API Gemini напрямую: из зависимостей только MCP SDK и zod, а ключ не
уходит никуда, кроме `generativelanguage.googleapis.com`.

## Инструменты

- `generate_video` запускает рендер, раз в 10 секунд проверяет готовность и сохраняет MP4. Принимает `prompt`
  и по желанию пути `image` (первый кадр) и `lastFrame` (последний), `negativePrompt`, `aspectRatio` (`16:9`, `9:16`),
  `durationSeconds` (4, 6, 8), `resolution` (`720p`, `1080p`, `4k`), `seed`, `model`, `filename` и `outputDir`.
  Возвращает путь к файлу. Пока ждёт, шлёт уведомления о прогрессе, чтобы клиент не оборвал вызов по таймауту.
- `list_models` показывает модели Veo, доступные ключу.

Veo тарифицируется за секунду видео, рендер идёт от одной до пяти минут.

## Установка

Нужна Node 26 или новее: сервер запускает исходники на TypeScript как есть, без сборки.

```bash
git clone https://github.com/aimuzov/veo-mcp.git
cd veo-mcp
npm ci --omit=dev
```

Потом добавить в конфиг MCP, пример в [.mcp.json.example](.mcp.json.example):

```json
{
	"mcpServers": {
		"veo": {
			"command": "node",
			"args": ["/path/to/veo-mcp/src/index.ts"],
			"env": { "GEMINI_API_KEY": "your-api-key" }
		}
	}
}
```

Ключ берётся в [AI Studio](https://aistudio.google.com/apikey). Для Veo у проекта должен быть включён биллинг.

| Переменная             | По умолчанию | Что делает                     |
| ---------------------- | ------------ | ------------------------------ |
| `GEMINI_API_KEY`       | нет          | Ключ Gemini API, обязателен    |
| `VEO_OUTPUT_DIR`       | `./veo`      | Куда сохранять видео           |
| `VEO_POLL_INTERVAL_MS` | `10000`      | Как часто проверять рендер     |
| `VEO_TIMEOUT_MS`       | `900000`     | Через сколько бросить ожидание |

## Разработка

```bash
npm install
npm test
npm run lint
npm run typecheck
```

Правила форматирования и линтера берутся из [infra-site-kit](https://github.com/aimuzov-projects/infra-site-kit).

## Лицензия

[MIT](LICENSE)
