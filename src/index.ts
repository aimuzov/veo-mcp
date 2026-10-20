import { loadConfig, serve } from './server.ts'

if (process.argv.includes('--help')) {
	console.log(`veo-mcp: MCP server for Google Veo video generation over stdio.

Environment:
  GEMINI_API_KEY        Gemini API key, required
  VEO_OUTPUT_DIR        where videos are saved, default ./veo
  VEO_POLL_INTERVAL_MS  how often to poll the render, default 10000
  VEO_TIMEOUT_MS        give up after, default 900000`)
} else {
	await serve(loadConfig())
}
