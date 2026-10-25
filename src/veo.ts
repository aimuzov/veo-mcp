import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

export const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const DEFAULT_MODEL = 'veo-3.1-generate-preview'

export const ASPECT_RATIOS = ['16:9', '9:16'] as const
export const DURATIONS = [4, 6, 8] as const
export const RESOLUTIONS = ['720p', '1080p', '4k'] as const

export type VideoRequest = {
	prompt: string
	/** Путь к кадру, с которого начинается видео. */
	image?: string
	/** Путь к кадру, которым видео заканчивается. Только вместе с `image`. */
	lastFrame?: string
	negativePrompt?: string
	aspectRatio?: (typeof ASPECT_RATIOS)[number]
	durationSeconds?: (typeof DURATIONS)[number]
	resolution?: (typeof RESOLUTIONS)[number]
	seed?: number
}

export type Operation = {
	name: string
	done?: boolean
	error?: { code?: number; message?: string }
	response?: {
		generateVideoResponse?: {
			generatedSamples?: { video?: { uri?: string } }[]
			raiMediaFilteredReasons?: string[]
		}
	}
}

// predictLongRunning ждёт картинку в формате Vertex: `inlineData` из generateContent он отвергает.
type EncodedImage = { bytesBase64Encoded: string; mimeType: string }

const MIME_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
}

export function mimeTypeOf(path: string): string {
	const mime = MIME_TYPES[extname(path).toLowerCase()]

	if (!mime) {
		throw new Error(`Unsupported image type: ${path}. Use one of ${Object.keys(MIME_TYPES).join(', ')}`)
	}

	return mime
}

async function loadImage(path: string): Promise<EncodedImage> {
	const mimeType = mimeTypeOf(path)
	const bytesBase64Encoded = (await readFile(resolve(path))).toString('base64')

	return { bytesBase64Encoded, mimeType }
}

/** Тело запроса `predictLongRunning`. Картинки читаются с диска и уходят base64. */
export async function buildBody(req: VideoRequest) {
	if (req.lastFrame && !req.image) {
		throw new Error('lastFrame needs image: Veo interpolates between the two')
	}

	const instance: Record<string, unknown> = { prompt: req.prompt }

	if (req.image) instance.image = await loadImage(req.image)

	if (req.lastFrame) instance.lastFrame = await loadImage(req.lastFrame)

	const parameters: Record<string, unknown> = {}

	if (req.aspectRatio) parameters.aspectRatio = req.aspectRatio

	if (req.durationSeconds) parameters.durationSeconds = req.durationSeconds

	if (req.resolution) parameters.resolution = req.resolution

	if (req.negativePrompt) parameters.negativePrompt = req.negativePrompt

	if (req.seed !== undefined) parameters.seed = req.seed

	// Каждый режим Veo принимает ровно одно значение, так что выбор за нас уже сделан.
	parameters.personGeneration = req.image ? 'allow_adult' : 'allow_all'

	return { instances: [instance], parameters }
}

/**
 * URI готового видео. Если операция упала или видео съел фильтр безопасности,
 * бросает ошибку с причиной от самого API, чтобы модель могла поправить промпт.
 */
export function videoUriOf(op: Operation): string {
	if (op.error) {
		throw new Error(`Veo failed: ${op.error.message ?? JSON.stringify(op.error)}`)
	}

	const res = op.response?.generateVideoResponse
	const uri = res?.generatedSamples?.[0]?.video?.uri

	if (uri) return uri

	const reasons = res?.raiMediaFilteredReasons?.join('; ')

	throw new Error(
		reasons ? `Veo filtered the video: ${reasons}` : `Veo returned no video: ${JSON.stringify(op.response ?? op)}`,
	)
}

export type WaitOptions = {
	intervalMs: number
	timeoutMs: number
	onTick?: (elapsedMs: number) => void
	signal?: AbortSignal
}

/**
 * Ответ API не 2xx. Код нужен, чтобы отличить временный сбой
 * от настоящей ошибки.
 */
export class ApiError extends Error {
	readonly status: number

	constructor(status: number, body: string) {
		super(`Gemini API ${status}: ${body}`)
		this.status = status
	}
}

// fetch бросает TypeError, когда ответа нет вовсе: DNS, обрыв, сброс соединения.
export const isTransient = (error: unknown): boolean =>
	error instanceof ApiError ? error.status === 429 || error.status >= 500 : error instanceof TypeError

const MAX_FAILURES = 5
const MAX_BACKOFF_MS = 60_000

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		signal?.throwIfAborted()

		const onAbort = () => {
			clearTimeout(timer)
			reject(signal?.reason)
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, ms)

		signal?.addEventListener('abort', onAbort, { once: true })
	})

export type VeoClient = ReturnType<typeof createVeoClient>

export function createVeoClient(apiKey: string, fetcher: typeof fetch = fetch) {
	async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
		const res = await fetcher(url, {
			...init,
			headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
		})

		if (!res.ok) throw new ApiError(res.status, await res.text())

		return (await res.json()) as T
	}

	async function listModels(): Promise<string[]> {
		const { models = [] } = await call<{ models?: { name: string }[] }>(`${BASE_URL}/models?pageSize=1000`)

		return models.map((m) => m.name.replace(/^models\//, '')).filter((name) => name.startsWith('veo'))
	}

	async function start(model: string, req: VideoRequest): Promise<string> {
		const op = await call<Operation>(`${BASE_URL}/models/${model}:predictLongRunning`, {
			method: 'POST',
			body: JSON.stringify(await buildBody(req)),
		})

		// Без имени опрос ушёл бы на `/undefined` и упал бы с непонятной 404.
		if (!op.name) throw new Error(`Veo returned no operation name: ${JSON.stringify(op)}`)

		return op.name
	}

	async function wait(name: string, { intervalMs, timeoutMs, onTick, signal }: WaitOptions): Promise<Operation> {
		const startedAt = Date.now()
		let failures = 0

		for (;;) {
			signal?.throwIfAborted()

			let delay = intervalMs

			try {
				const op = await call<Operation>(`${BASE_URL}/${name}`, { signal })

				if (op.done) return op

				failures = 0
			} catch (error) {
				if (signal?.aborted || !isTransient(error) || ++failures >= MAX_FAILURES) throw error

				delay = Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS)
			}

			const elapsed = Date.now() - startedAt

			if (elapsed >= timeoutMs) {
				throw new Error(`Veo did not finish in ${Math.round(timeoutMs / 1000)}s`)
			}

			onTick?.(elapsed)
			await sleep(delay, signal)
		}
	}

	// URI отвечает редиректом на сам файл и тоже требует ключ.
	async function download(uri: string, path: string, signal?: AbortSignal): Promise<void> {
		const res = await fetcher(uri, { headers: { 'x-goog-api-key': apiKey }, redirect: 'follow', signal })

		if (!res.ok) throw new Error(`Video download ${res.status}: ${await res.text()}`)

		await writeFile(path, Buffer.from(await res.arrayBuffer()))
	}

	return { listModels, start, wait, download }
}

export async function outputPath(dir: string, filename?: string): Promise<string> {
	const absDir = resolve(dir)

	await mkdir(absDir, { recursive: true })

	const base = filename?.replace(/\.mp4$/i, '') || `veo-${Date.now()}`

	return resolve(absDir, `${base}.mp4`)
}
