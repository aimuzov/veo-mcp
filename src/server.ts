import {
	failure,
	int,
	McpServer,
	messageOf,
	readVersion,
	str,
	tool,
	type Env,
	type RequestExtra,
} from '@aimuzov/infra-mcp-kit'
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

export const version = readVersion(import.meta.url)

export type Config = {
	apiKey: string
	outputDir: string
	pollIntervalMs: number
	timeoutMs: number
}

export function loadConfig(env: Env = process.env): Config {
	return {
		apiKey: str(env, 'GEMINI_API_KEY'),
		outputDir: str(env, 'VEO_OUTPUT_DIR', './veo'),
		pollIntervalMs: int(env, 'VEO_POLL_INTERVAL_MS', 10_000),
		timeoutMs: int(env, 'VEO_TIMEOUT_MS', 15 * 60_000),
	}
}

const NO_KEY = 'GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey'

/**
 * Без ключа сервер всё равно стартует: он живёт в глобальном конфиге MCP,
 * и машине без ключа лучше увидеть понятную ошибку в ответе инструмента, чем упавший сервер.
 */
export function createServer(cfg: Config, client: VeoClient = createVeoClient(cfg.apiKey)): McpServer {
	const server = new McpServer({ name: 'veo-mcp', version })

	/**
	 * Дождаться операции и скачать видео. Рендер к этому моменту уже оплачен,
	 * поэтому в любой ошибке есть имя операции: по нему видео докачает fetch_video.
	 */
	async function finish(
		name: string,
		{ filename, outputDir = cfg.outputDir }: { filename?: string; outputDir?: string },
		extra: RequestExtra,
	): Promise<string> {
		const progressToken = extra._meta?.progressToken

		try {
			const op = await client.wait(name, {
				intervalMs: cfg.pollIntervalMs,
				timeoutMs: cfg.timeoutMs,
				signal: extra.signal,
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

			await client.download(videoUriOf(op), path, extra.signal)

			return path
		} catch (error) {
			throw new Error(`${messageOf(error)}. Operation: ${name}`, { cause: error })
		}
	}

	const saveArgs = {
		filename: z.string().optional().describe('Base filename without extension'),
		outputDir: z.string().optional().describe(`Save directory, default ${cfg.outputDir}`),
	}

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
				...saveArgs,
			},
		},
		tool(async (args, extra) => {
			if (!cfg.apiKey) return failure(NO_KEY)

			const { model = DEFAULT_MODEL, filename, outputDir, ...req } = args

			return finish(await client.start(model, req), { filename, outputDir }, extra)
		}),
	)

	server.registerTool(
		'fetch_video',
		{
			title: 'Fetch a Veo video by operation',
			description:
				'Wait for an already started Veo operation and save its video. Use it when generate_video ' +
				'failed after the render had started: its error names the operation. Costs nothing extra.',
			inputSchema: {
				operation: z.string().min(1).describe('Operation name from the error, models/.../operations/...'),
				...saveArgs,
			},
		},
		tool(async ({ operation, ...save }, extra) => {
			if (!cfg.apiKey) return failure(NO_KEY)

			return finish(operation, save, extra)
		}),
	)

	server.registerTool(
		'list_models',
		{
			title: 'List Veo models',
			description: 'List Veo model ids available to this API key.',
			inputSchema: {},
		},
		tool(async () => {
			if (!cfg.apiKey) return failure(NO_KEY)

			const models = await client.listModels()

			return models.length ? models.join('\n') : 'No Veo models for this key'
		}),
	)

	return server
}
