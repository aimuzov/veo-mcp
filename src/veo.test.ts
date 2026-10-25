import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { BASE_URL, buildBody, createVeoClient, mimeTypeOf, outputPath, videoUriOf } from './veo.ts'

const tmp = () => mkdtemp(join(tmpdir(), 'veo-mcp-'))
const json = (body: unknown) => new Response(JSON.stringify(body))

/** fetch, который отвечает по таблице URL и запоминает запросы. */
function fakeFetch(routes: Record<string, () => Response>) {
	const calls: { url: string; init?: RequestInit }[] = []
	const fetcher = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init })

		const route = routes[url]

		if (!route) throw new Error(`unexpected ${url}`)

		return route()
	}) as typeof fetch

	return { fetcher, calls }
}

test('тип картинки определяется по расширению без учёта регистра', () => {
	assert.equal(mimeTypeOf('a/b.PNG'), 'image/png')
	assert.equal(mimeTypeOf('b.jpeg'), 'image/jpeg')
	assert.equal(mimeTypeOf('c.webp'), 'image/webp')
	assert.throws(() => mimeTypeOf('d.gif'), /Unsupported image type/)
})

test('text-to-video уходит с allow_all и только заданными параметрами', async () => {
	assert.deepEqual(await buildBody({ prompt: 'p', aspectRatio: '9:16', durationSeconds: 8 }), {
		instances: [{ prompt: 'p' }],
		parameters: { aspectRatio: '9:16', durationSeconds: 8, personGeneration: 'allow_all' },
	})
})

test('первый кадр встраивается base64 и переключает на allow_adult', async () => {
	const image = join(await tmp(), 'f.png')

	await writeFile(image, 'png-bytes')

	const body = await buildBody({ prompt: 'p', image, seed: 0 })

	assert.deepEqual(body.instances[0]?.image, {
		bytesBase64Encoded: Buffer.from('png-bytes').toString('base64'),
		mimeType: 'image/png',
	})

	assert.deepEqual(body.parameters, { seed: 0, personGeneration: 'allow_adult' })
})

test('последний кадр без первого отклоняется до запроса', async () => {
	await assert.rejects(buildBody({ prompt: 'p', lastFrame: 'x.png' }), /needs image/)
})

test('из готовой операции берётся первое видео', () => {
	const uri = videoUriOf({
		name: 'op',
		done: true,
		response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'u' } }] } },
	})

	assert.equal(uri, 'u')
})

test('ошибка операции и причина фильтра доходят до модели', () => {
	assert.throws(() => videoUriOf({ name: 'op', error: { message: 'quota' } }), /quota/)

	assert.throws(
		() =>
			videoUriOf({ name: 'op', response: { generateVideoResponse: { raiMediaFilteredReasons: ['celebrity'] } } }),
		/filtered the video: celebrity/,
	)
})

test('клиент запускает рендер, ждёт готовности и скачивает файл с ключом', async () => {
	let polls = 0
	const done = {
		name: 'op',
		done: true,
		response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files/v' } }] } },
	}
	const { fetcher, calls } = fakeFetch({
		[`${BASE_URL}/models/veo-x:predictLongRunning`]: () => json({ name: 'models/veo-x/operations/1' }),
		[`${BASE_URL}/models/veo-x/operations/1`]: () => json(++polls < 3 ? { name: 'op', done: false } : done),
		'https://files/v': () => new Response('mp4-bytes'),
	})
	const client = createVeoClient('key', fetcher)
	const ticks: number[] = []
	const name = await client.start('veo-x', { prompt: 'p' })
	const op = await client.wait(name, { intervalMs: 0, timeoutMs: 10_000, onTick: (t) => ticks.push(t) })
	const path = join(await tmp(), 'v.mp4')

	await client.download(videoUriOf(op), path)

	assert.equal(polls, 3)
	assert.equal(ticks.length, 2)
	assert.equal(await readFile(path, 'utf8'), 'mp4-bytes')
	assert.ok(calls.every((c) => new Headers(c.init?.headers).get('x-goog-api-key') === 'key'))
})

test('по таймауту опрос прекращается', async () => {
	const { fetcher } = fakeFetch({ [`${BASE_URL}/op/1`]: () => json({ name: 'op/1', done: false }) })

	await assert.rejects(
		createVeoClient('key', fetcher).wait('op/1', { intervalMs: 0, timeoutMs: 0 }),
		/did not finish/,
	)
})

test('сетевой сбой, 429 и 5xx при опросе повторяются, а не роняют рендер', async () => {
	const answers = [
		() => {
			throw new TypeError('fetch failed')
		},
		() => new Response('busy', { status: 503 }),
		() => new Response('slow down', { status: 429 }),
		() => json({ name: 'op/1', done: true }),
	]
	const { fetcher, calls } = fakeFetch({ [`${BASE_URL}/op/1`]: () => answers[calls.length - 1]!() })
	const op = await createVeoClient('key', fetcher).wait('op/1', { intervalMs: 0, timeoutMs: 10_000 })

	assert.equal(op.done, true)
	assert.equal(calls.length, 4)
})

test('постоянная ошибка опроса не повторяется', async () => {
	const { fetcher, calls } = fakeFetch({ [`${BASE_URL}/op/1`]: () => new Response('nope', { status: 404 }) })

	await assert.rejects(createVeoClient('key', fetcher).wait('op/1', { intervalMs: 0, timeoutMs: 10_000 }), {
		message: 'Gemini API 404: nope',
	})

	assert.equal(calls.length, 1)
})

test('временные сбои подряд в конце концов сдаются', async () => {
	const { fetcher, calls } = fakeFetch({ [`${BASE_URL}/op/1`]: () => new Response('down', { status: 500 }) })

	await assert.rejects(
		createVeoClient('key', fetcher).wait('op/1', { intervalMs: 0, timeoutMs: 10_000 }),
		/Gemini API 500/,
	)

	assert.equal(calls.length, 5)
})

test('отмена останавливает ожидание между опросами', async () => {
	const controller = new AbortController()
	const { fetcher, calls } = fakeFetch({ [`${BASE_URL}/op/1`]: () => json({ name: 'op/1', done: false }) })
	const waiting = createVeoClient('key', fetcher).wait('op/1', {
		intervalMs: 60_000,
		timeoutMs: 600_000,
		signal: controller.signal,
		onTick: () => controller.abort(new Error('cancelled')),
	})

	await assert.rejects(waiting, /cancelled/)
	assert.equal(calls.length, 1)
	// Отмена вызова доходит и до самого запроса опроса.
	assert.equal(calls[0]?.init?.signal?.aborted, true)
})

/** fetch, который не отвечает, пока запрос не оборвут. */
const hanging = (signal?: AbortSignal | null) =>
	new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))

test('повисший опрос не держит ожидание дольше тайм-аута', async () => {
	const fetcher = ((_url: string, init?: RequestInit) => hanging(init?.signal)) as typeof fetch
	const startedAt = Date.now()

	await assert.rejects(
		createVeoClient('key', fetcher).wait('op/1', { intervalMs: 0, timeoutMs: 50 }),
		/did not finish in 0s/,
	)

	assert.ok(Date.now() - startedAt < 1000)
})

test('повисший опрос повторяется, как временный сбой', async () => {
	let calls = 0
	const fetcher = (async (_url: string, init?: RequestInit) =>
		++calls === 1 ? hanging(init?.signal) : json({ name: 'op/1', done: true })) as typeof fetch

	const op = await createVeoClient('key', fetcher).wait('op/1', {
		intervalMs: 0,
		timeoutMs: 10_000,
		requestTimeoutMs: 20,
	})

	assert.equal(op.done, true)
	assert.equal(calls, 2)
})

test('ответ без имени операции отклоняется сразу, а не опросом /undefined', async () => {
	const { fetcher } = fakeFetch({ [`${BASE_URL}/models/veo-x:predictLongRunning`]: () => json({}) })

	await assert.rejects(createVeoClient('key', fetcher).start('veo-x', { prompt: 'p' }), /no operation name/)
})

test('тело ошибки API передаётся как есть', async () => {
	const { fetcher } = fakeFetch({
		[`${BASE_URL}/models?pageSize=1000`]: () => new Response('denied', { status: 403 }),
	})

	await assert.rejects(createVeoClient('key', fetcher).listModels(), { message: 'Gemini API 403: denied' })
})

test('из списка моделей остаются только Veo', async () => {
	const { fetcher } = fakeFetch({
		[`${BASE_URL}/models?pageSize=1000`]: () =>
			json({ models: [{ name: 'models/gemini-3-pro' }, { name: 'models/veo-3.1-generate-preview' }] }),
	})

	assert.deepEqual(await createVeoClient('key', fetcher).listModels(), ['veo-3.1-generate-preview'])
})

test('путь к видео создаёт папку и не удваивает .mp4', async () => {
	const dir = join(await tmp(), 'nested')

	assert.equal(await outputPath(dir, 'clip.mp4'), join(dir, 'clip.mp4'))
})

/**
 * Довести промис до конца на поддельных таймерах: дать отработать микрозадачам,
 * потом промотать часы до ближайшего таймера, и так пока промис не решится.
 */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
	let settled = false

	promise.then(
		() => (settled = true),
		() => (settled = true),
	)

	for (let i = 0; i < 1000 && !settled; i++) {
		await new Promise((resolve) => setImmediate(resolve))

		if (!settled) t.mock.timers.runAll()
	}

	return promise
}

/** Опрос по сценарию: каждый вызов берёт следующий ответ и запоминает время на поддельных часах. */
function scripted(answers: (() => Response)[]) {
	const at: number[] = []
	const fetcher = (async (url: string) => {
		assert.equal(url, `${BASE_URL}/op/1`)
		at.push(Date.now())

		const answer = answers[at.length - 1]

		if (!answer) throw new Error(`лишний опрос №${at.length}`)

		return answer()
	}) as typeof fetch

	return { fetcher, at }
}

const pending = () => json({ name: 'op/1', done: false })
const status = (code: number) => () => new Response('err', { status: code })
const offline = () => {
	throw new TypeError('fetch failed')
}

test('при временных сбоях пауза между опросами растёт вдвое', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })

	const { fetcher, at } = scripted([
		offline,
		status(503),
		status(429),
		status(500),
		() => json({ name: 'op/1', done: true }),
	])
	const op = await drive(t, createVeoClient('key', fetcher).wait('op/1', { intervalMs: 1000, timeoutMs: 600_000 }))

	assert.equal(op.done, true)
	// Паузы 2, 4, 8 и 16 секунд: interval * 2^failures.
	assert.deepEqual(at, [0, 2000, 6000, 14_000, 30_000])
})

test('пауза backoff не длиннее минуты', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })

	const { fetcher, at } = scripted([status(500), status(500), () => json({ name: 'op/1', done: true })])

	await drive(t, createVeoClient('key', fetcher).wait('op/1', { intervalMs: 40_000, timeoutMs: 600_000 }))

	assert.deepEqual(at, [0, 60_000, 120_000])
})

test('без сбоев опрос идёт с обычным интервалом, а успешный ответ сбрасывает счётчик сбоев', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })

	// Четыре сбоя, ответ, ещё четыре: без сброса пятый сбой подряд уронил бы опрос.
	const fails = Array.from({ length: 4 }, () => status(502))
	const { fetcher, at } = scripted([...fails, pending, ...fails, pending, () => json({ name: 'op/1', done: true })])
	const op = await drive(t, createVeoClient('key', fetcher).wait('op/1', { intervalMs: 10, timeoutMs: 600_000 }))

	assert.equal(op.done, true)
	assert.equal(at.length, 11)
	// Четвёртый сбой подряд даёт паузу interval * 16, а после ответа она снова равна интервалу.
	assert.equal(at[4]! - at[3]!, 160)
	assert.equal(at[5]! - at[4]!, 10)
	assert.equal(at[10]! - at[9]!, 10)
})

test('тайм-аут считается по часам от начала ожидания, onTick получает прошедшее время', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })

	const ticks: number[] = []
	const { fetcher, at } = scripted([pending, pending, pending, pending])
	const waiting = createVeoClient('key', fetcher).wait('op/1', {
		intervalMs: 10_000,
		timeoutMs: 30_000,
		onTick: (elapsed) => ticks.push(elapsed),
	})

	await assert.rejects(drive(t, waiting), { message: 'Veo did not finish in 30s' })
	assert.deepEqual(at, [0, 10_000, 20_000, 30_000])
	assert.deepEqual(ticks, [0, 10_000, 20_000])
})

test('тайм-аут срабатывает и тогда, когда опрос всё время падает временными сбоями', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })

	const { fetcher, at } = scripted([status(503), status(503), status(503)])
	const waiting = createVeoClient('key', fetcher).wait('op/1', { intervalMs: 1000, timeoutMs: 5000 })

	await assert.rejects(drive(t, waiting), /did not finish in 5s/)
	assert.deepEqual(at, [0, 2000, 6000])
})

test('отмена во время паузы обрывает её сразу, без следующего опроса', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })

	const controller = new AbortController()
	const { fetcher, at } = scripted([pending, pending])
	const waiting = createVeoClient('key', fetcher).wait('op/1', {
		intervalMs: 60_000,
		timeoutMs: 600_000,
		signal: controller.signal,
	})

	for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))

	controller.abort(new Error('cancelled'))

	await assert.rejects(waiting, { message: 'cancelled' })
	assert.deepEqual(at, [0])
})

test('отмена посреди запроса не повторяется как сетевой сбой', async () => {
	const controller = new AbortController()
	let calls = 0
	const fetcher = ((_url: string, init?: RequestInit) => {
		calls++

		// Так ведёт себя fetch при отмене: запрос падает, и это нельзя принять за обрыв сети.
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new TypeError('aborted')))
		})
	}) as typeof fetch
	const waiting = createVeoClient('key', fetcher).wait('op/1', {
		intervalMs: 0,
		timeoutMs: 600_000,
		signal: controller.signal,
	})

	controller.abort()

	await assert.rejects(waiting, { name: 'TypeError', message: 'aborted' })
	assert.equal(calls, 1)
})

test('уже отменённый сигнал не даёт сделать ни одного запроса', async () => {
	const { fetcher, calls } = fakeFetch({})

	await assert.rejects(
		createVeoClient('key', fetcher).wait('op/1', {
			intervalMs: 0,
			timeoutMs: 600_000,
			signal: AbortSignal.abort(new Error('gone')),
		}),
		{ message: 'gone' },
	)

	assert.equal(calls.length, 0)
})

test('ошибка скачивания несёт код и тело ответа', async () => {
	const { fetcher } = fakeFetch({ 'https://files/v': () => new Response('expired', { status: 404 }) })

	await assert.rejects(createVeoClient('key', fetcher).download('https://files/v', join(await tmp(), 'v.mp4')), {
		message: 'Video download 404: expired',
	})
})

test('операция без видео и без причины фильтра отдаёт ответ API как есть', () => {
	assert.throws(() => videoUriOf({ name: 'op', done: true, response: {} }), {
		message: 'Veo returned no video: {}',
	})

	assert.throws(() => videoUriOf({ name: 'op', done: true }), {
		message: 'Veo returned no video: {"name":"op","done":true}',
	})

	assert.throws(() => videoUriOf({ name: 'op', error: { code: 13 } }), { message: 'Veo failed: {"code":13}' })
})

test('запуск рендера шлёт тело predictLongRunning методом POST', async () => {
	const { fetcher, calls } = fakeFetch({
		[`${BASE_URL}/models/veo-x:predictLongRunning`]: () => json({ name: 'models/veo-x/operations/1' }),
	})

	assert.equal(
		await createVeoClient('key', fetcher).start('veo-x', { prompt: 'p', negativePrompt: 'n', resolution: '1080p' }),
		'models/veo-x/operations/1',
	)

	assert.equal(calls[0]?.init?.method, 'POST')

	assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
		instances: [{ prompt: 'p' }],
		parameters: { resolution: '1080p', negativePrompt: 'n', personGeneration: 'allow_all' },
	})
})

test('без имени файла видео называется по времени', async () => {
	const dir = await tmp()

	assert.match(await outputPath(dir), /\/veo-\d+\.mp4$/)
	assert.match(await outputPath(dir, ''), /\/veo-\d+\.mp4$/)
	assert.equal(await outputPath(dir, 'a.MP4'), join(dir, 'a.mp4'))
})
