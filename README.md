<p align="center">
	<img src="https://img.shields.io/badge/English-8b5cf6?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI+PGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg+PHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjQzgxMDJFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNDODEwMkUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg==" alt="English">
	<a href="README.ru.md"><img src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-555?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5IDYiPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0wIDBoOXYzSDB6Ii8+PHBhdGggZmlsbD0iIzAwMzlhNiIgZD0iTTAgMmg5djJIMHoiLz48cGF0aCBmaWxsPSIjZDUyYjFlIiBkPSJNMCA0aDl2MkgweiIvPjwvc3ZnPg==" alt="Русский"></a>
</p>

<p align="center">
	<a href="https://github.com/aimuzov/veo-mcp/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/aimuzov/veo-mcp/check.yml?branch=main&label=check" alt="Check"></a>
	<a href="package.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Faimuzov%2Fveo-mcp%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&logo=nodedotjs&logoColor=white&color=5fa04e" alt="Node"></a>
	<a href="LICENSE"><img src="https://img.shields.io/github/license/aimuzov/veo-mcp" alt="License"></a>
</p>

<h3 align="center">Google Veo as an MCP tool</h3>
<p align="center">Text-to-video and image-to-video through the Gemini API, MP4 files on disk</p>

A small MCP server that gives Claude Code, Claude Desktop or any other MCP client a `generate_video` tool backed by
Google Veo. It talks to the Gemini REST API directly: the only dependencies are the MCP SDK and zod, and the API key
never leaves the process for anywhere but `generativelanguage.googleapis.com`.

## Tools

- `generate_video` starts a render, polls it every 10 seconds and saves the MP4. Takes a `prompt` and, optionally,
  `image` (first frame) and `lastFrame` paths, `negativePrompt`, `aspectRatio` (`16:9`, `9:16`), `durationSeconds`
  (4, 6, 8), `resolution` (`720p`, `1080p`, `4k`), `seed`, `model`, `filename` and `outputDir`. Returns the file path.
  While it waits, it sends MCP progress notifications so the client doesn't time the call out.
- `list_models` lists the Veo models your key can use.

Veo is billed per second of video and a render takes one to five minutes.

## Setup

Node 26 or newer. The server is the npm package `@aimuzov/veo-mcp`: add it to your MCP config, see
[.mcp.json.example](.mcp.json.example):

```json
{
	"mcpServers": {
		"veo": {
			"command": "npx",
			"args": ["-y", "@aimuzov/veo-mcp"],
			"env": { "GEMINI_API_KEY": "your-api-key" }
		}
	}
}
```

Get a key at [AI Studio](https://aistudio.google.com/apikey). Veo needs a project with billing enabled.

| Variable               | Default  | What it does                 |
| ---------------------- | -------- | ---------------------------- |
| `GEMINI_API_KEY`       | none     | Gemini API key, required     |
| `VEO_OUTPUT_DIR`       | `./veo`  | Where videos are saved       |
| `VEO_POLL_INTERVAL_MS` | `10000`  | How often to poll the render |
| `VEO_TIMEOUT_MS`       | `900000` | When to give up on a render  |

## Development

```bash
npm install
npm start          # the TypeScript sources over stdio, no build
npm test
npm run lint
npm run typecheck
npm run build      # build/ for the npm package
```

Shared helpers and the CI steps come from [infra-mcp-kit](https://github.com/aimuzov/infra-mcp-kit), formatting and
lint rules from [infra-site-kit](https://github.com/aimuzov/infra-site-kit).

## License

[MIT](LICENSE)
