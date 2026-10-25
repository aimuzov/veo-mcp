import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { connectInMemory, expectTools, textOf } from '@aimuzov/infra-mcp-kit/testing'

import { createServer, loadConfig, type Config } from './server.ts'
import type { VeoClient } from './veo.ts'

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
