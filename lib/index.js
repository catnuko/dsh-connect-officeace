/**
 * dsh-connect-officeace —— 让 DSH 直接复用本机 OfficeAce 的华为 MaaS 模型通道。
 *
 * 设计要点（与 dsh-connect-trae / dsh-qoder-connect 的关键差异）：
 *
 * 1. Trae 与 Qoder 的上游是私有协议（Cloud-IDE-JWT + 自定义 SSE / COSY 签名），
 *    所以它们必须起一个 127.0.0.1 回环 shim，把私有协议翻译成 OpenAI 协议，
 *    再交给 `dsh-llm-pi-ai` 的 PiAiAdapter。OfficeAce 的网关本身就是
 *    OpenAI 兼容的（`POST {base}/v2/chat/completions`），因此本插件
 *    **不需要 shim、不需要 pi-ai**，直接手写 `LlmAdapter` + `fetch`。
 *
 * 2. 凭据不缓存于内存长期持有：每次请求都通过 `OfficeAceCredentials.resolve()`
 *    读取 OfficeAce 自己用 DPAPI + AES-256-GCM 保护的 profile。OfficeAce
 *    在会话续期或密钥轮换后会改写该文件，按 mtime 失效的缓存即可自愈。
 *    插件自身**无法刷新登录**——OfficeAce 会话过期时需用户重新打开 OfficeAce。
 *
 * 3. 只暴露 9 个实测可用的模型（`/v2/models` 广告 28 个，其余 19 个返回
 *    404 ModelArts.81009 / 403 无权限 / 400）。所有 9 个都支持 function calling，
 *    都会返回 `reasoning_content`，且**只支持文本输入**（网关拒绝 `image_url`）。
 *
 * 4. 每个模型的 `contextWindow` 与 `reasoning_effort` 取值集合均为实测结果，
 *    不是抄文档：发送非法 effort 会得到 HTTP 400 并回显合法集合；发送超大 prompt
 *    会得到 HTTP 400 并回显该模型真实的输入上限。
 */

import z from "@deepseek-ai/schemastery";
import {
	CONTEXT_WINDOW_EXCEEDED_CODE,
	EMPTY_RESPONSE_CODE,
	INVALID_CREDENTIAL_CODE,
	LlmAdapter,
	LlmError,
	QUOTA_EXCEEDED_CODE,
	attributionHeaders,
	isContextWindowExceededError,
	isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { OfficeAceCredentials, OfficeAceError } from "./credentials.js";
import { CREDITS_REFRESH_INTERVAL_MS, OfficeAceCreditsClient, toWebCredits } from "./credits.js";

/** 插件名，同时是 cordis.patch.yml 里 `insert[].id` 的取值。 */
export const name = "dsh-connect-officeace";

/** 只依赖 LLM 运行时；`settings` 通过 `ctx.inject` 软探测，缺席不影响注册。 */
export const inject = ["llm"];

/** 注册的 provider 路由 id。 */
export const OFFICEACE_PROVIDER = "officeace";

/** provider 展示名。 */
export const OFFICEACE_PROVIDER_NAME = "OfficeAce (Huawei MaaS)";

/** 设置命名空间的兜底值；真实值取 `ctx.fiber.entry.options.id`。 */
export const OFFICEACE_SETTINGS_NS = "officeace";

/** 网关实测接受的 max_tokens 上限为 131072；OfficeAce 自身默认用 32768。 */
export const DEFAULT_MAX_TOKENS = 32768;

/** 未知模型 id 的保守上下文窗口（9 个模型中最小实测上限为 glm-5.1 的 196608）。 */
export const FALLBACK_CONTEXT_WINDOW = 196608;

/** 积分读数路由：浏览器半边轮询它拿余额，与 Trae 的 `/plugins/<name>/usage` 同构。 */
export const OFFICEACE_CREDITS_PATH = "/plugins/dsh-connect-officeace/credits";

const TEXT_INDEX = 0;
const REASONING_INDEX = 1;
const TOOL_INDEX_BASE = 2;

/**
 * 9 个实测可用模型。`contextWindow` 取自网关在 prompt 超限时回显的
 * "maximum input length" / "input token limit"，`efforts` 取自非法 effort
 * 回显的合法集合，两者都经过 HTTP 200 复验。
 */
export const OFFICEACE_MODEL_SPECS = Object.freeze([
	{ id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1048576, efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
	{ id: "deepseek-v4.1-flash-0930", name: "DeepSeek-V4.1-Flash-0930", contextWindow: 1048576, efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
	{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextWindow: 1044480, efforts: ["low", "medium", "high", "xhigh", "max"] },
	{ id: "deepseek-v4-flash-0731", name: "DeepSeek-V4-Flash-0731", contextWindow: 1048576, efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
	{ id: "glm-5.1", name: "GLM-5.1", contextWindow: 196608, efforts: ["low", "medium", "high", "xhigh", "max"] },
	{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 1044480, efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
	{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 1044480, efforts: ["low", "high", "max"] },
	{ id: "Kimi-K2.6", name: "Kimi-K2.6", contextWindow: 262144, efforts: ["low", "medium", "high", "xhigh", "max"] },
	{ id: "kimi-k2.6", name: "Kimi-K2.6 (legacy id)", contextWindow: 262144, efforts: ["low", "medium", "high", "xhigh", "max"] },
]);

const EFFORT_NAMES = Object.freeze({
	none: "None",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Max",
});

/** 网关在 prompt 超限时使用的措辞，`isContextWindowExceededError` 覆盖不到。 */
const OFFICEACE_OVERFLOW_PATTERN =
	/prompt length exceeds|maximum input length|input token limit|maximum context length|context length exceed|too long for (?:this|the) model/i;

/**
 * schemastery 3.18.4 的 `volatile()` 是可选能力，做特性探测以免版本差异直接抛错。
 * @param {object} schema - 待包装的 schema。
 * @returns {object} 具备 volatile 能力时返回 volatile schema，否则原样返回。
 */
export const asVolatile = (schema) => (typeof schema?.volatile === "function" ? schema.volatile() : schema);

/**
 * 拆掉 volatile 包装。volatile 字段在配置对象里是 `{get(): T}` 形状的引用，
 * 必须在读取时解包，否则会拿到一个函数对象。
 * @param {unknown} value - 配置字段当前值。
 * @returns {unknown} 解包后的真实值。
 */
export const unwrapVolatile = (value) =>
	value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;

/**
 * 取本插件的 settings 命名空间。Loader 以 entry id 作为命名空间键，
 * 写死常量会让设置面板读成"未配置"。
 * @param {object} ctx - cordis 上下文。
 * @returns {string} 命名空间。
 */
export const settingsNamespaceOf = (ctx) => {
	const id = ctx?.fiber?.entry?.options?.id;
	return typeof id === "string" && id.length > 0 ? id : OFFICEACE_SETTINGS_NS;
};

/** 正整数守卫。 */
function positiveInt(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 按配置过滤/覆盖模型目录。 */
function configuredModels(config) {
	const enabled = unwrapVolatile(config?.enabledModelIds);
	const allow = Array.isArray(enabled) ? enabled.filter((id) => typeof id === "string" && id.length > 0) : [];
	const budgets = unwrapVolatile(config?.contextBudgets);
	const rows = allow.length > 0 ? OFFICEACE_MODEL_SPECS.filter((spec) => allow.includes(spec.id)) : OFFICEACE_MODEL_SPECS;
	return rows.map((spec) => ({
		...spec,
		contextWindow: (budgets !== null && typeof budgets === "object" ? positiveInt(budgets[spec.id]) : undefined) ?? spec.contextWindow,
	}));
}

/** 把 harness 的内容块数组压成纯文本；图片/文件在此兜底为占位符。 */
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image omitted: OfficeAce gateway accepts text input only]");
		else if (block.type === "file") parts.push("[file omitted: OfficeAce gateway accepts text input only]");
	}
	return parts.join("");
}

/**
 * harness 消息 → OpenAI messages。
 *
 * 实测约束：网关的 role 白名单是 `['system','assistant','function','user','tool']`，
 * 传入 `developer` 会 400，因此 developer 必须降级为 system；而 `role:"tool"` +
 * `tool_call_id` 是被原生接受的，不要重写成 user。中段 system 消息也被接受。
 */
function buildMessages(messages) {
	const out = [];
	for (const message of messages) {
		if (message === null || typeof message !== "object") continue;
		const role = message.role;
		if (role === "developer" || role === "system") {
			const text = textOf(message.content);
			if (text.length > 0) out.push({ role: "system", content: text });
			continue;
		}
		if (role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			const text = textOf(content.filter((block) => block?.type === "text"));
			const reasoning = textOf(content.filter((block) => block?.type === "reasoning"));
			const calls = content
				.filter((block) => block?.type === "tool-call")
				.map((block) => ({
					id: block.id,
					type: "function",
					function: { name: block.name, arguments: typeof block.arguments === "string" ? block.arguments : "" },
				}));
			const entry = { role: "assistant", content: text };
			if (reasoning.length > 0) entry.reasoning_content = reasoning;
			if (calls.length > 0) entry.tool_calls = calls;
			out.push(entry);
			continue;
		}
		if (role === "tool") {
			out.push({
				role: "tool",
				...(typeof message.toolCallId === "string" ? { tool_call_id: message.toolCallId } : {}),
				content: textOf(message.content),
			});
			continue;
		}
		out.push({ role: "user", content: textOf(message.content) });
	}
	return out;
}

/** 构造网关请求体。不发送 `stream_options`——usage 本来就随末帧到达。 */
function buildRequestBody(options) {
	const messages = [];
	if (typeof options.system === "string" && options.system.length > 0) messages.push({ role: "system", content: options.system });
	messages.push(...buildMessages(Array.isArray(options.messages) ? options.messages : []));

	const body = {
		model: options.model,
		messages,
		stream: true,
		max_tokens: positiveInt(options.maxTokens) ?? DEFAULT_MAX_TOKENS,
	};
	if (Number.isFinite(options.temperature)) body.temperature = options.temperature;
	if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = [...options.stop];
	if (typeof options.reasoningEffort === "string" && options.reasoningEffort.length > 0) body.reasoning_effort = options.reasoningEffort;

	const tools = (Array.isArray(options.tools) ? options.tools : []).filter((tool) => tool && typeof tool.name === "string" && tool.name.length > 0);
	if (tools.length > 0) {
		body.tools = tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				...(typeof tool.description === "string" && tool.description.length > 0 ? { description: tool.description } : {}),
				...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
			},
		}));
		body.tool_choice = "auto";
	}
	return body;
}

/** 取出一个 SSE 帧里的 data 载荷。 */
function dataPayload(frame) {
	const parts = [];
	for (const line of frame.split("\n")) {
		if (!line.startsWith("data:")) continue;
		parts.push(line.slice(5).replace(/^ /, ""));
	}
	return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * 逐帧产出 SSE 的 data 载荷。统一去掉裸 CR，使 `\r\n\r\n` 与 `\n\n` 一致。
 * @param {ReadableStream} body - fetch 响应体。
 */
async function* sseFrames(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const payload = dataPayload(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				if (payload !== undefined) yield payload;
				boundary = buffer.indexOf("\n\n");
			}
		}
		buffer += decoder.decode().replace(/\r/g, "");
		const payload = dataPayload(buffer);
		if (payload !== undefined) yield payload;
	} finally {
		try {
			await reader.cancel();
		} catch {
			// 流已关闭
		}
	}
}

/** 网关 usage → harness usage。 */
function normalizeUsage(usage) {
	const input = usage?.prompt_tokens;
	const output = usage?.completion_tokens;
	const total = usage?.total_tokens;
	const cached = usage?.prompt_tokens_details?.cached_tokens;
	return {
		inputTokens: Number.isFinite(input) ? input : 0,
		outputTokens: Number.isFinite(output) ? output : 0,
		...(Number.isFinite(total) ? { totalTokens: total } : {}),
		...(Number.isFinite(cached) ? { cacheReadTokens: cached } : {}),
	};
}

/** OpenAI finish_reason → harness finish kind。 */
function finishKind(reason) {
	if (reason === "tool_calls") return "tool-calls";
	if (reason === "length") return "max-tokens";
	return "stop";
}

/** 把任何异常翻译成带稳定 code 的 LlmError，避免上游看到 UNKNOWN。 */
function transportFailure(error, signal) {
	if (signal?.aborted) return new LlmError("OfficeAce request aborted", "ABORTED");
	const name = error?.name;
	if (name === "AbortError") return new LlmError("OfficeAce request aborted", "ABORTED");
	if (name === "TimeoutError") return new LlmError("OfficeAce gateway request timed out", "TIMEOUT");
	const cause = error?.cause;
	const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
	return new LlmError(`OfficeAce gateway is unreachable: ${detail}`, "TRANSPORT", { cause: error });
}

/** 非 2xx 响应 → 带稳定 code 的 LlmError。 */
async function httpFailure(response) {
	const status = response.status;
	let raw = "";
	try {
		raw = await response.text();
	} catch {
		raw = "";
	}
	let message = raw;
	let code;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.error?.message === "string") message = parsed.error.message;
		else if (typeof parsed?.message === "string") message = parsed.message;
		if (typeof parsed?.error?.code === "string") code = parsed.error.code;
	} catch {
		// 非 JSON 错误体，保留原文
	}
	const text = `${code ?? ""} ${message}`;
	const summary = `${code ?? `HTTP ${status}`}: ${message}`.slice(0, 500);

	const retryAfter = response.headers.get("retry-after");
	const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
	const options = { status, ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? { providerRetryAfterMs: retryAfterSeconds * 1000 } : {}) };

	if (status === 401 || status === 403) return new LlmError(`OfficeAce gateway rejected the credential (${summary})`, "AUTH", options);
	if (status === 429) return new LlmError(`OfficeAce gateway rate limited the request (${summary})`, "RATE_LIMIT", options);
	if (status >= 500) return new LlmError(`OfficeAce gateway failed (${summary})`, "SERVER", options);
	if (isContextWindowExceededError(text) || OFFICEACE_OVERFLOW_PATTERN.test(text)) {
		return new LlmError(`OfficeAce model rejected the prompt as too long (${summary})`, CONTEXT_WINDOW_EXCEEDED_CODE, options);
	}
	if (isQuotaExceededError(text)) return new LlmError(`OfficeAce quota exhausted (${summary})`, QUOTA_EXCEEDED_CODE, options);
	return new LlmError(`OfficeAce gateway rejected the request (${summary})`, "INVALID_REQUEST", options);
}

/**
 * OfficeAce 的 LlmAdapter：直连华为 MaaS 网关，不使用回环 shim 与 pi-ai。
 */
export class OfficeAceAdapter extends LlmAdapter {
	#credentialStore;
	#models;

	/**
	 * @param {{credentialStore: () => OfficeAceCredentials, models: () => Array<object>}} options
	 */
	constructor(options) {
		super();
		this.#credentialStore = options.credentialStore;
		this.#models = options.models;
	}

	/** 路由元数据；`id` 必须严格等于 provider，否则注册期抛 INVALID_ADAPTER。 */
	providerInfo(provider) {
		return { id: provider, name: OFFICEACE_PROVIDER_NAME };
	}

	/** 目录只广告实测可用的模型；未列出的 id 仍可被核心路由调用。 */
	async listModels(provider) {
		return this.#models().map((spec) => ({
			provider,
			id: spec.id,
			name: spec.name,
			description: `OfficeAce · ${spec.id}`,
			inputModalities: ["text"],
		}));
	}

	/**
	 * 解析模型能力。不设 `defaultEffort`：不显式请求 effort 时不发送
	 * `reasoning_effort`，沿用网关自身默认，行为最贴近 OfficeAce 本体。
	 */
	async resolveModel(provider, model) {
		const spec = this.#models().find((row) => row.id === model);
		const info = {
			provider,
			id: model,
			name: spec?.name ?? model,
			context: { contextWindow: spec?.contextWindow ?? FALLBACK_CONTEXT_WINDOW },
			defaultMaxTokens: DEFAULT_MAX_TOKENS,
			// 只支持文本：声明 text 后运行时会把图片替换成文本占位符，而不是发出去吃 400。
			inputModalities: ["text"],
			// 网关接受中段 system 消息，因此系统提示可以就地更新。
			systemPromptUpdate: "in-history",
		};
		if (spec === undefined || spec.efforts.length === 0) return info;
		return {
			...info,
			reasoning: { efforts: spec.efforts.map((id) => ({ id, name: EFFORT_NAMES[id] ?? id })) },
		};
	}

	/** 凭据解析失败一律转成 INVALID_CREDENTIAL，提示用户重新登录 OfficeAce。 */
	async #credentials() {
		try {
			return await this.#credentialStore().resolve();
		} catch (error) {
			if (error instanceof OfficeAceError) {
				throw new LlmError(`OfficeAce credential unavailable (${error.code}): ${error.message}`, INVALID_CREDENTIAL_CODE);
			}
			const detail = error instanceof Error ? error.message : String(error);
			throw new LlmError(`OfficeAce credential unavailable: ${detail}`, INVALID_CREDENTIAL_CODE);
		}
	}

	/** @returns {AsyncIterable<object>} harness StreamChunk 序列。 */
	async *stream(options) {
		const credential = await this.#credentials();
		let response;
		try {
			response = await fetch(`${credential.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					// 契约要求每个 provider HTTP 请求都带上归属头。
					...attributionHeaders(),
					"content-type": "application/json",
					accept: "text/event-stream",
					authorization: credential.authorization,
				},
				body: JSON.stringify(buildRequestBody(options)),
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
		} catch (error) {
			throw transportFailure(error, options.signal);
		}
		if (!response.ok) throw await httpFailure(response);
		if (response.body === null) throw new LlmError("OfficeAce gateway returned an empty response body", "TRANSPORT");
		try {
			yield* this.#translate(response.body, options.signal);
		} catch (error) {
			// 已经带稳定 code 的失败原样抛出；其余（含流中途断连、abort）统一翻译，
			// 否则 HarnessError 之外的错误会退化成不可重试的 UNKNOWN。
			if (error instanceof LlmError) throw error;
			throw transportFailure(error, options.signal);
		}
	}

	/**
	 * OpenAI SSE → harness StreamChunk。
	 *
	 * 关键顺序：`block-end` 与 `usage` 必须早于 `finish`，但网关把 usage 放在
	 * finish_reason 之后的 `choices:[]` 帧里，所以 finish 要缓冲到流末尾再发。
	 * @param {ReadableStream} body - fetch 响应体。
	 * @param {AbortSignal} [signal] - 调用方信号，用于区分 abort。
	 */
	async *#translate(body, signal) {
		const order = [];
		const byIndex = new Map();
		let usageFrame;
		let finishReason;
		let sawDone = false;

		const ensure = (index, blockType) => {
			let entry = byIndex.get(index);
			if (entry !== undefined) return { entry, started: false };
			entry = { index, blockType, text: "", id: undefined, name: undefined, args: "" };
			byIndex.set(index, entry);
			order.push(entry);
			return { entry, started: true };
		};

		for await (const payload of sseFrames(body)) {
			if (payload === "[DONE]") {
				sawDone = true;
				break;
			}
			let frame;
			try {
				frame = JSON.parse(payload);
			} catch {
				continue;
			}
			if (frame === null || typeof frame !== "object") continue;

			// 末帧形状：{choices: [], usage: {...}}
			if (frame.usage !== null && typeof frame.usage === "object") usageFrame = frame.usage;

			const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
			if (choice === null || choice === undefined) continue;
			if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) finishReason = choice.finish_reason;

			const delta = choice.delta;
			if (delta === null || typeof delta !== "object") continue;

			// reasoning_content 是 delta 的兄弟字段，不是 content 数组里的块。
			if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
				const { entry, started } = ensure(REASONING_INDEX, "reasoning");
				if (started) yield { type: "block-start", index: REASONING_INDEX, blockType: "reasoning" };
				entry.text += delta.reasoning_content;
				yield { type: "reasoning-delta", index: REASONING_INDEX, text: delta.reasoning_content };
			}

			if (typeof delta.content === "string" && delta.content.length > 0) {
				const { entry, started } = ensure(TEXT_INDEX, "text");
				if (started) yield { type: "block-start", index: TEXT_INDEX, blockType: "text" };
				entry.text += delta.content;
				yield { type: "text-delta", index: TEXT_INDEX, text: delta.content };
			}

			if (Array.isArray(delta.tool_calls)) {
				for (const call of delta.tool_calls) {
					if (call === null || typeof call !== "object") continue;
					const slot = Number.isInteger(call.index) && call.index >= 0 ? call.index : 0;
					const index = TOOL_INDEX_BASE + slot;
					const { entry, started } = ensure(index, "tool-call");
					if (typeof call.id === "string" && call.id.length > 0) entry.id = call.id;
					const fn = call.function;
					if (fn !== null && typeof fn === "object" && typeof fn.name === "string" && fn.name.length > 0) entry.name = fn.name;
					const argumentsDelta = fn !== null && typeof fn === "object" && typeof fn.arguments === "string" ? fn.arguments : "";
					entry.args += argumentsDelta;
					if (started) yield { type: "block-start", index, blockType: "tool-call" };
					yield {
						type: "tool-call-delta",
						index,
						id: entry.id ?? `call-${index}`,
						...(entry.name === undefined ? {} : { name: entry.name }),
						argumentsDelta,
					};
				}
			}
		}

		// 既没有终止帧也没有 [DONE]，说明连接被截断。
		if (finishReason === undefined && !sawDone) {
			throw new LlmError("OfficeAce gateway stream ended before a terminal finish reason", "TRANSPORT");
		}
		// 契约：终止于 stop 却没有任何内容块时，归类为可重试的 EMPTY_RESPONSE。
		if (order.length === 0) {
			throw new LlmError("OfficeAce gateway returned a completion with no content blocks", EMPTY_RESPONSE_CODE);
		}

		for (const entry of order) {
			if (entry.blockType === "text") yield { type: "block-end", index: entry.index, block: { type: "text", text: entry.text } };
			else if (entry.blockType === "reasoning") yield { type: "block-end", index: entry.index, block: { type: "reasoning", text: entry.text } };
			else {
				yield {
					type: "block-end",
					index: entry.index,
					block: { type: "tool-call", id: entry.id ?? `call-${entry.index}`, name: entry.name ?? "", arguments: entry.args },
				};
			}
		}

		if (usageFrame !== undefined) yield { type: "usage", usage: normalizeUsage(usageFrame) };
		yield { type: "finish", reason: { kind: finishKind(finishReason) } };
	}
}

/**
 * 插件配置。只有 volatile 字段会出现在 Web 设置表单里，也只有它们能被界面写入。
 */
export const Config = z.object({
	installRoot: asVolatile(z.string().description("OfficeAce 安装根目录，留空自动探测")),
	profileFile: asVolatile(z.string().description("可选：直接指定 oauth-<userId>.json 路径")),
	enabledModelIds: asVolatile(z.array(z.string()).default([]).description("启用的模型 id 白名单，留空表示全部 9 个实测可用模型")),
	contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description("按模型 id 覆盖上下文窗口"),
});

/**
 * 注册 OfficeAce provider。只新增 provider 路由，不改动 profile 的默认模型。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 已按 Config 归一化的配置。
 */
export function apply(ctx, config) {
	const settingsNs = settingsNamespaceOf(ctx);
	const current = () => config;

	// 凭据读取器按配置签名缓存，既保留 mtime 自愈，又跟随配置变更。
	let credentialCache = { key: undefined, store: undefined };
	const credentialStore = () => {
		const live = current();
		const installRoot = unwrapVolatile(live?.installRoot);
		const profileFile = unwrapVolatile(live?.profileFile);
		const root = typeof installRoot === "string" && installRoot.length > 0 ? installRoot : "";
		const profile = typeof profileFile === "string" && profileFile.length > 0 ? profileFile : "";
		const key = `${root}|${profile}`;
		if (credentialCache.key !== key) {
			credentialCache = {
				key,
				store: new OfficeAceCredentials({
					installRoot: root.length > 0 ? root : undefined,
					profileFile: profile.length > 0 ? profile : undefined,
				}),
			};
		}
		return credentialCache.store;
	};

	const adapter = new OfficeAceAdapter({ credentialStore, models: () => configuredModels(current()) });
	const registration = { adapter: undefined, discovery: undefined, directory: undefined };

	registration.adapter = ctx.llm.registerAdapter([OFFICEACE_PROVIDER], adapter);
	registration.discovery = ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
		if (typeof request?.provider === "string" && request.provider.length > 0 && request.provider !== OFFICEACE_PROVIDER) return [];
		return configuredModels(current()).map((spec) => ({
			id: spec.id,
			name: spec.name,
			contextWindow: spec.contextWindow,
			maxTokens: DEFAULT_MAX_TOKENS,
			inputModalities: ["text"],
		}));
	});
	registration.directory = ctx.llm.registerConfigurableProviders([
		{
			provider: OFFICEACE_PROVIDER,
			displayName: OFFICEACE_PROVIDER_NAME,
			settingsNs,
			settingsPath: [],
			declared: false,
		},
	]);

	// 声明本 fiber 的 settings 命名空间，让 volatile 字段能出现在设置面板里。
	ctx.inject(["settings"], (settingsCtx) => {
		try {
			ctx.effect(() => settingsCtx.settings.configure({ auto: true }, ctx.fiber));
		} catch (error) {
			ctx.logger.warn("dsh-connect-officeace: settings namespace unavailable", error);
		}
	});

	// 积分读数路由。webServer 是可选服务：缺席（如 headless 组合）时整块跳过，
	// 不影响 provider 注册 —— 与 Trae 插件同一条原则。
	ctx.inject(["webServer"], (webCtx) => {
		const creditsClient = new OfficeAceCreditsClient({ credentialStore });
		ctx.effect(() => {
			const dispose = webCtx.webServer.register({
				kind: "exact",
				path: OFFICEACE_CREDITS_PATH,
				handler: async (req, res) => {
					if (req.method !== "GET") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					// 只回环来源：这个端点会把账号的余额暴露给浏览器，别的机器不该读到。
					if (!loopbackOrigin(req)) {
						json(res, 403, { error: "origin-not-trusted" });
						return;
					}
					try {
						const credits = await creditsClient.read(req.signal);
						json(res, 200, { ...toWebCredits(credits), refreshIntervalMs: CREDITS_REFRESH_INTERVAL_MS });
					} catch (error) {
						// 读数失败绝不带出内部细节：原因已在 toWebCredits 里收敛成稳定措辞。
						ctx.logger.warn("dsh-connect-officeace: credits read failed", error);
						json(res, 200, { status: "unavailable", message: "积分暂不可读", refreshIntervalMs: CREDITS_REFRESH_INTERVAL_MS });
					}
				},
			});
			return dispose;
		}, "dsh-connect-officeace: credits route");
	});

	ctx.effect(() => () => {
		registration.discovery?.();
		registration.adapter?.();
		registration.directory?.();
	});
}

/** Loopback browser origins only; other devices are refused until trusted origins exist. */
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

/** 写一段 JSON 响应。 */
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}
