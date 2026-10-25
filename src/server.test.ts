import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { StdioServerTransport } from '@aimuzov/infra-mcp-kit'
import { connectInMemory, expectTools, textOf } from '@aimuzov/infra-mcp-kit/testing'

import { createServer, loadConfig, type Config } from './server.ts'
import { BASE_URL, createVeoClient, type Operation, type VeoClient } from './veo.ts'

// Что клиент видит в notifications/progress. Своим типом, а не из SDK: тест должен пережить смену SDK.
type Progress = { progress: number; total?: number; message?: string }

const config = (over: Partial<Config> = {}): Config => ({ ...loadConfig({ GEMINI_API_KEY: 'key' }), ...over })

/** Клиент Veo без сети: рендер готов сразу, а скачивание ничего не пишет. */
const fakeClient = (over: Partial<VeoClient> = {}): VeoClient => ({
	listModels: async () => ['veo-3.1-generate-preview'],
	start: async () => 'op/1',
	wait: async () => ({ name: 'op/1', done: true }),
	download: async () => {},
	...over,
})

test('сервер отдаёт ровно свои инструменты', async () => {
	await expectTools(await connectInMemory(createServer(config(), fakeClient())), [
		'fetch_video',
		'generate_video',
		'list_models',
	])
})

test('без ключа инструмент отвечает ошибкой со ссылкой на ключ, а не падает', async () => {
	const client = await connectInMemory(createServer(config({ apiKey: '' }), fakeClient()))
	const result = await client.callTool({ name: 'list_models', arguments: {} })

	assert.equal(result.isError, true)
	assert.match(textOf(result), /GEMINI_API_KEY/)
})

test('ошибка API доходит до модели текстом с isError', async () => {
	const client = await connectInMemory(
		createServer(
			config(),
			fakeClient({
				listModels: async () => {
					throw new Error('Gemini API 403: denied')
				},
			}),
		),
	)
	const result = await client.callTool({ name: 'list_models', arguments: {} })

	assert.equal(result.isError, true)
	assert.equal(textOf(result), 'Gemini API 403: denied')
})

test('generate_video возвращает путь к сохранённому mp4', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'veo-mcp-'))
	const op = {
		name: 'op/1',
		done: true,
		response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'u' } }] } },
	}
	const client = await connectInMemory(createServer(config(), fakeClient({ wait: async () => op })))
	const result = await client.callTool({
		name: 'generate_video',
		arguments: { prompt: 'p', filename: 'clip', outputDir: dir },
	})

	assert.equal(result.isError, undefined)
	assert.equal(textOf(result), join(dir, 'clip.mp4'))
})

test('ошибка после старта рендера называет операцию, чтобы видео можно было докачать', async () => {
	const client = await connectInMemory(
		createServer(
			config(),
			fakeClient({
				wait: async () => {
					throw new Error('Gemini API 500: oops')
				},
			}),
		),
	)
	const result = await client.callTool({ name: 'generate_video', arguments: { prompt: 'p' } })

	assert.equal(result.isError, true)
	assert.equal(textOf(result), 'Gemini API 500: oops. Operation: op/1')
})

test('fetch_video докачивает видео по имени операции без нового рендера', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'veo-mcp-'))
	const waited: string[] = []
	const signals: (AbortSignal | undefined)[] = []
	const client = await connectInMemory(
		createServer(
			config(),
			fakeClient({
				start: async () => assert.fail('рендер не должен запускаться заново'),
				wait: async (name, opts) => {
					waited.push(name)
					signals.push(opts.signal)

					return {
						name,
						done: true,
						response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'u' } }] } },
					}
				},
			}),
		),
	)
	const result = await client.callTool({
		name: 'fetch_video',
		arguments: { operation: 'models/veo-x/operations/7', filename: 'again', outputDir: dir },
	})

	assert.equal(textOf(result), join(dir, 'again.mp4'))
	assert.deepEqual(waited, ['models/veo-x/operations/7'])
	assert.ok(signals[0] instanceof AbortSignal)
})

const OP = 'models/veo-x/operations/7'
const VIDEO = 'https://files/v'
const done = (over: Partial<Operation> = {}): Operation => ({
	name: OP,
	done: true,
	response: { generateVideoResponse: { generatedSamples: [{ video: { uri: VIDEO } }] } },
	...over,
})
const json = (body: unknown) => new Response(JSON.stringify(body))

/**
 * Настоящий клиент Veo поверх fetch по таблице URL: проверяет сервер целиком, без сети.
 * Ответ опроса берётся по очереди из `polls`, последний повторяется.
 */
function veoApi({
	polls = [done()],
	download = () => new Response('mp4-bytes'),
}: {
	polls?: Operation[]
	download?: () => Response
} = {}) {
	const calls: { url: string; init?: RequestInit }[] = []
	let polled = 0
	const fetcher = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init })

		if (url === `${BASE_URL}/models/veo-x:predictLongRunning`) return json({ name: OP })

		if (url === `${BASE_URL}/${OP}`) return json(polls[Math.min(polled++, polls.length - 1)])

		if (url === VIDEO) return download()

		throw new Error(`unexpected ${url}`)
	}) as typeof fetch

	return { client: createVeoClient('key', fetcher), calls }
}

const tmp = () => mkdtemp(join(tmpdir(), 'veo-mcp-'))

test('generate_video отправляет в API только параметры рендера и модель по умолчанию', async () => {
	const dir = await tmp()
	const requests: { model: string; req: unknown }[] = []
	const client = await connectInMemory(
		createServer(
			config({ outputDir: dir }),
			fakeClient({
				start: async (model, req) => {
					requests.push({ model, req: JSON.parse(JSON.stringify(req)) })

					return 'op/1'
				},
			}),
		),
	)

	await client.callTool({
		name: 'generate_video',
		arguments: { prompt: 'p', aspectRatio: '9:16', durationSeconds: 4, seed: 3, filename: 'f', outputDir: dir },
	})

	await client.callTool({ name: 'generate_video', arguments: { prompt: 'p', model: 'veo-y' } })

	assert.deepEqual(requests, [
		{ model: 'veo-3.1-generate-preview', req: { prompt: 'p', aspectRatio: '9:16', durationSeconds: 4, seed: 3 } },
		{ model: 'veo-y', req: { prompt: 'p' } },
	])
})

test('без outputDir видео ложится в каталог из конфига', async () => {
	const dir = await tmp()
	const client = await connectInMemory(createServer(config({ outputDir: dir }), veoApi().client))
	const result = await client.callTool({ name: 'fetch_video', arguments: { operation: OP, filename: 'x' } })

	assert.equal(textOf(result), join(dir, 'x.mp4'))
	assert.equal(await readFile(join(dir, 'x.mp4'), 'utf8'), 'mp4-bytes')
})

test('fetch_video дожидается готового рендера и сохраняет его без нового запуска', async () => {
	const dir = await tmp()
	const api = veoApi({ polls: [{ name: OP, done: false }, done()] })
	const client = await connectInMemory(createServer(config({ pollIntervalMs: 0 }), api.client))
	const result = await client.callTool({
		name: 'fetch_video',
		arguments: { operation: OP, filename: 'again', outputDir: dir },
	})

	assert.equal(result.isError, undefined)
	assert.equal(textOf(result), join(dir, 'again.mp4'))
	assert.equal(await readFile(join(dir, 'again.mp4'), 'utf8'), 'mp4-bytes')

	assert.deepEqual(
		api.calls.map((c) => c.url),
		[`${BASE_URL}/${OP}`, `${BASE_URL}/${OP}`, VIDEO],
	)
})

test('fetch_video на ещё не готовом рендере сдаётся по тайм-ауту и снова называет операцию', async () => {
	const api = veoApi({ polls: [{ name: OP, done: false }] })
	const client = await connectInMemory(createServer(config({ pollIntervalMs: 0, timeoutMs: 0 }), api.client))
	const result = await client.callTool({ name: 'fetch_video', arguments: { operation: OP, outputDir: await tmp() } })

	assert.equal(result.isError, true)
	assert.equal(textOf(result), `Veo did not finish in 0s. Operation: ${OP}`)
	assert.ok(api.calls.every((c) => c.url !== VIDEO))
})

test('fetch_video на рендере с ошибкой отдаёт причину от API и операцию', async () => {
	const api = veoApi({ polls: [{ name: OP, done: true, error: { code: 3, message: 'bad prompt' } }] })
	const client = await connectInMemory(createServer(config(), api.client))
	const result = await client.callTool({ name: 'fetch_video', arguments: { operation: OP, outputDir: await tmp() } })

	assert.equal(result.isError, true)
	assert.equal(textOf(result), `Veo failed: bad prompt. Operation: ${OP}`)
})

// Рендер уже оплачен, поэтому в каждой ошибке после старта должно быть имя операции.
for (const [title, api, outputDir] of [
	[
		'видео съел фильтр',
		() =>
			veoApi({
				polls: [
					{ name: OP, done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['r'] } } },
				],
			}),
		undefined,
	],
	['скачивание упало', () => veoApi({ download: () => new Response('expired', { status: 403 }) }), undefined],
	['каталог не создаётся', () => veoApi(), '/dev/null/veo'],
] as const) {
	test(`после старта рендера ошибка называет операцию: ${title}`, async () => {
		const client = await connectInMemory(createServer(config({ pollIntervalMs: 0 }), api().client))
		const result = await client.callTool({
			name: 'generate_video',
			arguments: { prompt: 'p', model: 'veo-x', outputDir: outputDir ?? (await tmp()) },
		})

		assert.equal(result.isError, true)
		assert.match(textOf(result), new RegExp(`\\. Operation: ${OP}$`))
	})
}

test('ошибка до старта рендера операцию не называет: её ещё нет', async () => {
	const api = veoApi()
	const client = await connectInMemory(createServer(config(), api.client))
	const result = await client.callTool({
		name: 'generate_video',
		arguments: { prompt: 'p', model: 'veo-x', lastFrame: 'end.png' },
	})

	assert.equal(result.isError, true)
	assert.equal(textOf(result), 'lastFrame needs image: Veo interpolates between the two')
	assert.equal(api.calls.length, 0)
})

test('пока рендер идёт, клиент получает progress-нотификации', async () => {
	const dir = await tmp()
	const api = veoApi({ polls: [{ name: OP, done: false }, { name: OP, done: false }, done()] })
	const client = await connectInMemory(createServer(config({ pollIntervalMs: 0, timeoutMs: 600_000 }), api.client))
	const progress: Progress[] = []
	const result = await client.callTool(
		{ name: 'generate_video', arguments: { prompt: 'p', model: 'veo-x', outputDir: dir } },
		undefined,
		{ onprogress: (p) => progress.push(p) },
	)

	assert.equal(result.isError, undefined)
	assert.equal(progress.length, 2)

	for (const p of progress) {
		assert.equal(p.total, 600_000)
		assert.equal(typeof p.progress, 'number')
		assert.match(p.message ?? '', /^Veo is rendering, \d+s$/)
	}

	assert.ok(progress[1]!.progress >= progress[0]!.progress)
})

test('fetch_video тоже шлёт прогресс', async () => {
	const api = veoApi({ polls: [{ name: OP, done: false }, done()] })
	const client = await connectInMemory(createServer(config({ pollIntervalMs: 0 }), api.client))
	const progress: Progress[] = []

	await client.callTool({ name: 'fetch_video', arguments: { operation: OP, outputDir: await tmp() } }, undefined, {
		onprogress: (p) => progress.push(p),
	})

	assert.equal(progress.length, 1)
})

test('отмена вызова клиентом останавливает ожидание рендера', async () => {
	const api = veoApi({ polls: [{ name: OP, done: false }] })
	const client = await connectInMemory(createServer(config({ pollIntervalMs: 60_000 }), api.client))
	const controller = new AbortController()
	const call = client.callTool({ name: 'fetch_video', arguments: { operation: OP } }, undefined, {
		signal: controller.signal,
	})

	await until(() => api.calls.length === 1)
	controller.abort()

	await assert.rejects(call)

	const signal = api.calls[0]?.init?.signal

	await until(() => signal?.aborted === true)
	// Сервер не ушёл на следующий опрос через минуту: пауза оборвана, процесс не висит.
	assert.equal(api.calls.length, 1)
})

// Тот же путь, что у `npx veo-mcp`: голый JSON-RPC построчно через stdio-транспорт кита.
// До кита 3.0 отмена по stdio доходила только до ответа, а опрос рендера шёл дальше.
test('notifications/cancelled по stdio обрывает опрос рендера', async () => {
	const api = veoApi({ polls: [{ name: OP, done: false }] })
	const server = createServer(config({ pollIntervalMs: 60_000 }), api.client)
	const input = new PassThrough()
	const output = new PassThrough()
	const send = (message: object) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

	await server.connect(new StdioServerTransport(input, output))

	send({
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
	})

	send({ method: 'notifications/initialized' })
	send({ id: 2, method: 'tools/call', params: { name: 'fetch_video', arguments: { operation: OP } } })

	await until(() => api.calls.length === 1)
	send({ method: 'notifications/cancelled', params: { requestId: 2, reason: 'user' } })

	const signal = api.calls[0]?.init?.signal

	await until(() => signal?.aborted === true)
	assert.equal(api.calls.length, 1)
	await server.close()
})

test('без GEMINI_API_KEY сервер стартует, а каждый инструмент объясняет, где взять ключ', async () => {
	const cfg = loadConfig({})

	assert.equal(cfg.apiKey, '')

	// Клиент Veo по умолчанию: на старте он не должен ходить в сеть.
	const client = await connectInMemory(createServer(cfg))
	const calls = [
		{ name: 'list_models', arguments: {} },
		{ name: 'generate_video', arguments: { prompt: 'p' } },
		{ name: 'fetch_video', arguments: { operation: OP } },
	]

	for (const call of calls) {
		const result = await client.callTool(call)

		assert.equal(result.isError, true, call.name)
		assert.equal(textOf(result), 'GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey')
	}
})

test('list_models без моделей Veo говорит об этом прямо', async () => {
	const client = await connectInMemory(createServer(config(), fakeClient({ listModels: async () => [] })))

	assert.equal(textOf(await client.callTool({ name: 'list_models', arguments: {} })), 'No Veo models for this key')
})

test('конфиг читает окружение и подставляет значения по умолчанию', () => {
	assert.deepEqual(loadConfig({ GEMINI_API_KEY: 'k' }), {
		apiKey: 'k',
		outputDir: './veo',
		pollIntervalMs: 10_000,
		timeoutMs: 900_000,
	})

	assert.deepEqual(
		loadConfig({ GEMINI_API_KEY: 'k', VEO_OUTPUT_DIR: '/v', VEO_POLL_INTERVAL_MS: '5', VEO_TIMEOUT_MS: '7' }),
		{ apiKey: 'k', outputDir: '/v', pollIntervalMs: 5, timeoutMs: 7 },
	)
})

/** Подождать условие на настоящих часах, но не дольше пары секунд. */
async function until(check: () => boolean) {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))

	assert.ok(check(), 'условие не наступило')
}
