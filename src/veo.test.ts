import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

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

test('по таймауту ошибка называет операцию, чтобы её можно было найти', async () => {
	const { fetcher } = fakeFetch({ [`${BASE_URL}/op/1`]: () => json({ name: 'op/1', done: false }) })

	await assert.rejects(
		createVeoClient('key', fetcher).wait('op/1', { intervalMs: 0, timeoutMs: 0 }),
		/did not finish.*op\/1/,
	)
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
