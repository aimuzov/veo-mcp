import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const CLI = fileURLToPath(new URL('./index.ts', import.meta.url))
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

// Ключ из окружения разработчика не должен попасть в дочерний процесс: сеть в тестах закрыта.
const env = { PATH: process.env.PATH, GEMINI_API_KEY: '' }

/** Запустить CLI и дождаться выхода. Код выхода возвращается, а не бросается. */
async function run(...args: string[]) {
	try {
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { env })

		return { code: 0, stdout, stderr }
	} catch (error) {
		const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string }

		return { code, stdout, stderr }
	}
}

test('--help печатает справку с командами и переменными окружения', async () => {
	const { code, stdout } = await run('--help')

	assert.equal(code, 0)
	assert.match(stdout, /^veo-mcp: MCP server for Google Veo video generation over stdio\./)
	assert.match(stdout, /Usage: veo-mcp \[serve\|--help\|--version\]/)

	for (const name of ['GEMINI_API_KEY', 'VEO_OUTPUT_DIR', 'VEO_POLL_INTERVAL_MS', 'VEO_TIMEOUT_MS']) {
		assert.match(stdout, new RegExp(`^  ${name} `, 'm'))
	}

	assert.equal((await run('-h')).stdout, stdout)
})

test('--version печатает версию из package.json', async () => {
	assert.deepEqual(await run('--version'), { code: 0, stdout: `${version}\n`, stderr: '' })
	assert.equal((await run('-v')).stdout, `${version}\n`)
})

test('неизвестная команда даёт код 2 и справку', async () => {
	const { code, stderr } = await run('nope')

	assert.equal(code, 2)
	assert.match(stderr, /nope/)
	assert.match(stderr, /Usage: veo-mcp/)
})

test('HTTP-режима нет: serve --http завершается ошибкой', async () => {
	const { code, stderr } = await run('serve', '--http')

	assert.equal(code, 1)
	assert.match(stderr, /^veo-mcp: /)
})

test('без GEMINI_API_KEY stdio-сервер стартует и отвечает инструментом с ошибкой', async () => {
	const child = spawn(process.execPath, [CLI], { env, stdio: ['pipe', 'pipe', 'inherit'] })
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()

	/** JSON-RPC построчно, как его шлёт любой MCP-клиент: без SDK на этой стороне. */
	async function request(id: number, method: string, params: object) {
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)

		const { value } = await lines.next()

		return JSON.parse(String(value)) as { id: number; result: Record<string, unknown> }
	}

	try {
		const init = await request(1, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '0.0.0' },
		})

		assert.deepEqual(init.result.serverInfo, { name: 'veo-mcp', version })
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

		const call = await request(2, 'tools/call', { name: 'list_models', arguments: {} })

		assert.equal(call.id, 2)

		assert.deepEqual(call.result, {
			content: [
				{ type: 'text', text: 'GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey' },
			],
			isError: true,
		})

		// Клиент закрывает stdin, когда сервер больше не нужен: процесс должен выйти сам.
		const exited = once(child, 'exit')

		child.stdin.end()
		assert.deepEqual(await exited, [0, null])
	} finally {
		child.kill()
	}
})
