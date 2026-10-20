import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
	ASPECT_RATIOS,
	createVeoClient,
	DEFAULT_MODEL,
	DURATIONS,
	outputPath,
	RESOLUTIONS,
	videoUriOf,
	type VeoClient,
} from './veo.ts'

// Версию читаем в рантайме, чтобы рукопожатие MCP не отставало от package.json.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export type Config = {
	apiKey: string
	outputDir: string
	pollIntervalMs: number
	timeoutMs: number
}

export function loadConfig(env = process.env): Config {
	return {
		apiKey: env.GEMINI_API_KEY ?? '',
		outputDir: env.VEO_OUTPUT_DIR || './veo',
		pollIntervalMs: Number(env.VEO_POLL_INTERVAL_MS) || 10_000,
		timeoutMs: Number(env.VEO_TIMEOUT_MS) || 15 * 60_000,
	}
}

const NO_KEY = 'GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const failure = (e: unknown) => ({ ...text(e instanceof Error ? e.message : String(e)), isError: true })

/**
 * Без ключа сервер всё равно стартует: он живёт в глобальном конфиге MCP,
 * и машине без ключа лучше увидеть понятную ошибку в ответе инструмента, чем упавший сервер.
 */
export function createServer(cfg: Config, client: VeoClient = createVeoClient(cfg.apiKey)): McpServer {
	const server = new McpServer({ name: 'veo-mcp', version })

	server.registerTool(
		'generate_video',
		{
			title: 'Generate a video with Veo',
			description:
				'Generate a video from a text prompt with Google Veo, optionally starting from an image ' +
				'(image-to-video) and ending on another one. Paid per second of video and takes 1-5 minutes, ' +
				'so ask before generating several variants. Saves an MP4 to disk and returns its path.',
			inputSchema: {
				prompt: z.string().min(1).describe('What happens in the video, including camera and sound'),
				image: z.string().optional().describe('Path to the first frame: png, jpg or webp'),
				lastFrame: z.string().optional().describe('Path to the last frame. Requires image'),
				negativePrompt: z.string().optional().describe('What must not appear'),
				aspectRatio: z.enum(ASPECT_RATIOS).optional().describe('Default 16:9'),
				durationSeconds: z.literal(DURATIONS).optional().describe('Default 8. 1080p and 4k need 8'),
				resolution: z.enum(RESOLUTIONS).optional().describe('Default 720p'),
				seed: z.number().int().optional(),
				model: z.string().optional().describe(`Veo model id, default ${DEFAULT_MODEL}. See list_models`),
				filename: z.string().optional().describe('Base filename without extension'),
				outputDir: z.string().optional().describe(`Save directory, default ${cfg.outputDir}`),
			},
		},
		async (args, extra) => {
			if (!cfg.apiKey) return failure(NO_KEY)

			const { model = DEFAULT_MODEL, filename, outputDir = cfg.outputDir, ...req } = args
			const progressToken = extra._meta?.progressToken

			try {
				const name = await client.start(model, req)
				const op = await client.wait(name, {
					intervalMs: cfg.pollIntervalMs,
					timeoutMs: cfg.timeoutMs,
					// Рендер идёт минутами: прогресс не даёт клиенту оборвать вызов по таймауту.
					onTick: (elapsed) => {
						if (progressToken === undefined) return

						void extra.sendNotification({
							method: 'notifications/progress',
							params: {
								progressToken,
								progress: elapsed,
								total: cfg.timeoutMs,
								message: `Veo is rendering, ${Math.round(elapsed / 1000)}s`,
							},
						})
					},
				})
				const path = await outputPath(outputDir, filename)

				await client.download(videoUriOf(op), path)

				return text(path)
			} catch (e) {
				return failure(e)
			}
		},
	)

	server.registerTool(
		'list_models',
		{
			title: 'List Veo models',
			description: 'List Veo model ids available to this API key.',
			inputSchema: {},
		},
		async () => {
			if (!cfg.apiKey) return failure(NO_KEY)

			try {
				const models = await client.listModels()

				return text(models.length ? models.join('\n') : 'No Veo models for this key')
			} catch (e) {
				return failure(e)
			}
		},
	)

	return server
}

export async function serve(cfg: Config): Promise<void> {
	await createServer(cfg).connect(new StdioServerTransport())
	console.error('veo-mcp running on stdio')
}
