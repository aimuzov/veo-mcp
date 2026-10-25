/**
 * Контракт протокола глазами клиента: список инструментов со схемами и формы ответов.
 * Тест не знает, на каком SDK собран сервер, и должен пережить его смену без правок.
 * Фикстура переснимается так: `UPDATE_CONTRACT=1 node --test src/contract.test.ts`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { connectInMemory } from '@aimuzov/infra-mcp-kit/testing'

import { createServer, loadConfig, version } from './server.ts'
import type { VeoClient } from './veo.ts'

const FIXTURE = new URL('./contract.tools.json', import.meta.url)

let started = 0

const fakeClient: VeoClient = {
	listModels: async () => ['veo-3.1-generate-preview', 'veo-3.0-generate-001'],
	start: async () => {
		started++

		return 'op/1'
	},
	wait: async () => ({ name: 'op/1', done: true, error: { message: 'quota' } }),
	download: async () => {},
}

/**
 * Инструмент так, как его видит клиент по проводу: после JSON, без полей, которые SDK
 * добавляет от себя. `$schema` (диалект JSON Schema) и `execution` (задачи MCP) выбирает
 * библиотека, а не сервер, поэтому в контракт они не входят.
 */
function contractOf({ name, title, description, inputSchema }: Record<string, unknown>) {
	const { $schema: _dialect, ...schema } = inputSchema as Record<string, unknown>

	return wire({ name, title, description, inputSchema: schema })
}

/** Ответ после JSON: поля со значением undefined по проводу не доезжают. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const connect = () => connectInMemory(createServer(loadConfig({ GEMINI_API_KEY: 'key' }), fakeClient))

test('tools/list совпадает с фикстурой: имена, описания и inputSchema', async () => {
	const tools = (await (await connect()).listTools()).tools.map(contractOf)

	if (process.env.UPDATE_CONTRACT) await writeFile(FIXTURE, `${JSON.stringify(tools, null, '\t')}\n`)

	assert.deepEqual(tools, JSON.parse(await readFile(FIXTURE, 'utf8')))
})

test('initialize называет сервер и объявляет инструменты', async () => {
	const client = await connect()

	assert.deepEqual(client.getServerVersion(), { name: 'veo-mcp', version })
	assert.ok(client.getServerCapabilities()?.tools)
})

test('успех: один текстовый блок без isError', async () => {
	const result = await (await connect()).callTool({ name: 'list_models', arguments: {} })

	assert.deepEqual(wire(result), {
		content: [{ type: 'text', text: 'veo-3.1-generate-preview\nveo-3.0-generate-001' }],
	})
})

test('успех generate_video: путь к файлу одним текстом', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'veo-mcp-'))
	const client = await connectInMemory(
		createServer(loadConfig({ GEMINI_API_KEY: 'key' }), {
			...fakeClient,
			wait: async () => ({
				name: 'op/1',
				done: true,
				response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'u' } }] } },
			}),
		}),
	)
	const result = await client.callTool({
		name: 'generate_video',
		arguments: { prompt: 'p', filename: 'clip', outputDir: dir },
	})

	assert.deepEqual(wire(result), { content: [{ type: 'text', text: join(dir, 'clip.mp4') }] })
})

test('ошибка инструмента: результат с isError и текстом, а не JSON-RPC ошибка', async () => {
	const result = await (await connect()).callTool({ name: 'fetch_video', arguments: { operation: 'op/1' } })

	assert.deepEqual(wire(result), {
		content: [{ type: 'text', text: 'Veo failed: quota. Operation: op/1' }],
		isError: true,
	})
})

test('ошибка валидации аргументов: isError с именами полей, обработчик не вызывается', async () => {
	const before = started
	const result = await (
		await connect()
	).callTool({
		name: 'generate_video',
		arguments: { prompt: '', aspectRatio: '1:1', durationSeconds: 5 },
	})

	assert.equal(result.isError, true)
	assert.equal((result.content as unknown[]).length, 1)

	const [block] = result.content as { type: string; text: string }[]

	assert.equal(block?.type, 'text')

	for (const field of ['prompt', 'aspectRatio', 'durationSeconds']) assert.match(block?.text ?? '', new RegExp(field))

	assert.equal(started, before)
})

test('обязательный аргумент без значения тоже ошибка валидации', async () => {
	const result = await (await connect()).callTool({ name: 'fetch_video', arguments: {} })

	assert.equal(result.isError, true)
	assert.match(JSON.stringify(result.content), /operation/)
})
