<p align="center">
	<a href="README.md"><img src="https://img.shields.io/badge/English-555?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI+PGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg+PHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjQzgxMDJFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNDODEwMkUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg==" alt="English"></a>
	<img src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-8b5cf6?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5IDYiPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0wIDBoOXYzSDB6Ii8+PHBhdGggZmlsbD0iIzAwMzlhNiIgZD0iTTAgMmg5djJIMHoiLz48cGF0aCBmaWxsPSIjZDUyYjFlIiBkPSJNMCA0aDl2MkgweiIvPjwvc3ZnPg==" alt="Русский">
</p>

<p align="center">
	<img src=".github/assets/banner.jpg" alt="veo-mcp: видео Google Veo прямо из Claude" width="100%">
</p>

<p align="center">
	<a href="https://github.com/aimuzov/veo-mcp/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/aimuzov/veo-mcp/check.yml?branch=main&label=check" alt="Check"></a>
	<a href="https://github.com/aimuzov/veo-mcp/releases"><img src="https://img.shields.io/github/v/release/aimuzov/veo-mcp?sort=semver&label=version" alt="Version"></a>
	<a href="package.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Faimuzov%2Fveo-mcp%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&logo=nodedotjs&logoColor=white&color=5fa04e" alt="Node"></a>
	<a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-server-8b5cf6" alt="MCP"></a>
	<a href="LICENSE"><img src="https://img.shields.io/github/license/aimuzov/veo-mcp" alt="License"></a>
</p>

<h3 align="center">Google Veo как инструмент MCP</h3>
<p align="center">Видео по тексту и по картинке через Gemini API, MP4 на диске</p>

MCP-сервер, который даёт Claude Code, Claude Desktop и любому другому MCP-клиенту генерацию видео через Google Veo. Ходит в Gemini API напрямую: видео по тексту, по картинке и переход между первым и последним кадром. MP4 сохраняется на машине, где запущен сервер.

## Инструменты

- `generate_video` запускает рендер, ждёт его и сохраняет MP4. Принимает `prompt` и, по желанию:
    - `image`, первый кадр (png, jpg, webp), и `lastFrame`, который требует `image`;
    - `negativePrompt`, `seed`;
    - `aspectRatio`: `16:9` (по умолчанию) или `9:16`;
    - `durationSeconds`: 4, 6 или 8 (по умолчанию); для `1080p` и `4k` нужно 8;
    - `resolution`: `720p` (по умолчанию), `1080p` или `4k`;
    - `model` (по умолчанию `veo-3.1-generate-preview`), `filename`, `outputDir`.

    Возвращает путь к файлу. Пока ждёт, шлёт MCP-уведомления о прогрессе, чтобы клиент не оборвал вызов по таймауту.

- `fetch_video` дожидается уже идущего рендера и сохраняет его по имени операции. Если `generate_video` упал после старта рендера, в его ошибке есть имя операции: `fetch_video` докачает видео без второй оплаты.
- `list_models` показывает модели Veo, доступные твоему ключу.

Veo тарифицируется посекундно, а рендер идёт от одной до пяти минут, поэтому инструмент просит модель уточнить, прежде чем генерировать несколько вариантов. Сетевые ошибки, 429 и 5xx повторяются с паузой. Если видео отсеял фильтр безопасности, в ошибке будет причина.

## Установка

Нужен Node 26 или новее. Добавь сервер в конфиг MCP, см. [.mcp.json.example](.mcp.json.example):

```json
{
	"mcpServers": {
		"veo": {
			"command": "npx",
			"args": ["-y", "@aimuzov/veo-mcp"],
			"env": { "GEMINI_API_KEY": "your-api-key", "VEO_OUTPUT_DIR": "./veo" }
		}
	}
}
```

Ключ берётся в [AI Studio](https://aistudio.google.com/apikey), для Veo у проекта должен быть включён биллинг. Без ключа сервер всё равно стартует, а каждый инструмент отвечает этой подсказкой.

Сервер работает только по stdio: видео — это файл на диске машины, которая его сделала, а размещённый коннектор оставил бы его на чужом сервере.

| Переменная             | По умолчанию | Что делает                          |
| ---------------------- | ------------ | ----------------------------------- |
| `GEMINI_API_KEY`       |              | Ключ Gemini API, обязателен         |
| `VEO_OUTPUT_DIR`       | `./veo`      | Куда сохранять видео                |
| `VEO_POLL_INTERVAL_MS` | `10000`      | Как часто опрашивать рендер         |
| `VEO_TIMEOUT_MS`       | `900000`     | Когда перестать ждать рендер        |
| `LOG_LEVEL`            | `info`       | `error`, `warn`, `info` или `debug` |

## Разработка

```bash
npm install
npm start          # исходники TypeScript по stdio, без сборки
npm test
npm run lint
npm run typecheck
npm run build      # build/ для npm-пакета
```

Общие хелперы и шаги CI берутся из [infra-mcp-kit](https://github.com/aimuzov/infra-mcp-kit), правила форматирования и линтера — из [infra-site-kit](https://github.com/aimuzov/infra-site-kit).

## Лицензия

[MIT](LICENSE)
