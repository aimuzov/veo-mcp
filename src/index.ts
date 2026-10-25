#!/usr/bin/env node
import { runCli } from '@aimuzov/infra-mcp-kit'

import { createServer, loadConfig, version } from './server.ts'

// HTTP-режима нет намеренно: видео сохраняется на диск машины, где запущен сервер,
// и у удалённого коннектора пользователь его бы просто не увидел.
await runCli({
	name: 'veo-mcp',
	version,
	usage: `veo-mcp: MCP server for Google Veo video generation over stdio.

Usage: veo-mcp [serve|--help|--version]

Environment:
  GEMINI_API_KEY        Gemini API key, required
  VEO_OUTPUT_DIR        where videos are saved, default ./veo
  VEO_POLL_INTERVAL_MS  how often to poll the render, default 10000
  VEO_TIMEOUT_MS        give up after, default 900000`,
	stdio: () => createServer(loadConfig()),
})
