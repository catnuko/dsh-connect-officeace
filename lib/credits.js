/**
 * OfficeAce 积分读数：读它自己本地 API 的只读订阅端点。
 *
 * ## 为什么需要这个模块
 *
 * OfficeAce 的模型网关（`model_api_url_base`）是标准 OpenAI 兼容端点，
 * 只接受 chat/completions 与 models，**不提供任何余额/配额查询**（实测 30 余个
 * 候选路径全部 404 `APIG.0101`）。积分数据在另一侧：OfficeAce 桌面应用在自己
 * 的机器上起了一个本地 API（`https://127.0.0.1:<port>`，自签证书），Web UI 通过
 * 它读 `/api/subscription/*`。
 *
 * ## 鉴权怎么复用
 *
 * 该 API 的业务路由要求三个自定义头，取值全部来自 OfficeAce 自己的会话记录
 * （`storage.sqlite` 的 `oc_kv_string` 表）：
 *
 * ```
 * X-Office-Claw-User:    <userId>
 * Authorization:         Bearer <sessionId>
 * X-Office-Claw-Session: <sessionId>
 * ```
 *
 * 因此同机同用户下的任意进程都可以复用同一份身份去读只读端点 —— 与本插件
 * 复用模型凭据是同一个边界（不防同用户进程）。
 *
 * ## 设计约束
 *
 * - **只读**：只发 GET，绝不调用任何会改变账号状态的端点。
 * - **OfficeAce 不在运行时不报错**：本地 API 不可达时返回 `reachable: false`，
 *   由调用方决定怎么降级；模型通道走外网网关，与本地 API 是否存活无关。
 * - **不缓存**：每次读数都重新读会话记录。会话记录的 mtime 变化即重新解析，
 *   与 `OfficeAceCredentials.resolve()` 的自愈策略一致。
 */

import https from 'node:https';

import { OfficeAceError, defaultApiBase } from './credentials.js';

/** 订阅快照端点（返回套餐 + 积分分组 + 福利明细）。 */
export const SUBSCRIPTION_CURRENT_PATH = '/api/subscription/current';

/** 每日消耗明细端点。 */
export const SUBSCRIPTION_USAGE_PATH = '/api/subscription/usage';

/**
 * 读数的最小周期。积分以「模型调用」为粒度变化，5 分钟的边际价值已经很低，
 * 与 `dsh-connect-trae` 的输入框读数周期一致。
 */
export const CREDITS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** 单次读数的超时。本地 API 正常时是毫秒级，2 秒足够覆盖一次冷启动。 */
const REQUEST_TIMEOUT_MS = 2000;

/**
 * 把任意数值收敛成有限数；其余（undefined / NaN / Infinity）返回 undefined。
 * 积分字段缺失时必须留空而不是伪造 0 —— 「0 积分」和「读不到」是两件事。
 *
 * 负数**原样保留**：上游用负 `total` 表达「无上限」套餐（OfficeAce 自己的
 * 订阅卡片就判 `total < 0` → 显示「无上限」），收敛掉负号会把无上限误报成
 * 一个很小的余额。
 * @param {unknown} value - 原始值。
 * @returns {number | undefined} 归一后的数值。
 */
function finiteOrUndefined(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 同 {@link finiteOrUndefined}，但把负数压到 0。
 * 只用于「剩余量」这类语义上不可能为负的字段。
 * @param {unknown} value - 原始值。
 * @returns {number | undefined} 归一后的非负数值。
 */
function clampNonNegative(value) {
	const finite = finiteOrUndefined(value);
	return finite === undefined ? undefined : Math.max(0, finite);
}

/**
 * 收敛一个积分分组。上游形状：
 * `{ key, name, kind, tier?, activityId?, remaining, total, used, expiresAt?, expired }`
 * @param {unknown} raw - 原始分组对象。
 * @returns {object | undefined} 归一后的分组；形状不符时返回 undefined。
 */
function normalizeGroup(raw) {
	if (raw === null || typeof raw !== 'object') return undefined;
	const record = raw;
	const key = record.key;
	const name = record.name;
	if (typeof key !== 'string' || key.length === 0) return undefined;
	if (typeof name !== 'string' || name.length === 0) return undefined;
	// 上游偶发给出负 remaining（用量与总量不同源）。剩余余额不可能为负，
	// 这里归零而不是丢弃：丢弃会让 UI 显示「—」，看着像读不到。
	const remaining = clampNonNegative(record.remaining);
	const total = finiteOrUndefined(record.total);
	const used = finiteOrUndefined(record.used);
	const kind = typeof record.kind === 'string' ? record.kind : 'unknown';
	const expired = record.expired === true;
	const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : null;
	// 上游对「无上限」的套餐会给负 total；这种分组不能参与求和，单独标注。
	const unlimited = total !== undefined && total < 0;
	return {
		key,
		name,
		kind,
		expired,
		expiresAt,
		unlimited,
		// 无上限分组不透传负数哨兵，理由同 normalizeCredits。
		...(remaining === undefined ? {} : { remaining }),
		...(unlimited || total === undefined ? {} : { total }),
		...(unlimited || used === undefined ? {} : { used }),
	};
}

/**
 * 把 `/api/subscription/current` 的响应收敛成紧凑文档。
 *
 * 顶层 `totalCredits` / `usedCredits` 是上游自己的汇总口径，`creditGroups` 是
 * 按积分包分出的明细。读数只认顶层汇总：它在 UI 上和 OfficeAce 的订阅卡片
 * 对得上，而明细求和与汇总不保证相等（实测本机 500+4000+675+1000 ≠ 6500，
 * 因为签到福利的 `total` 会跨天重置）。一个在宿主 UI 里找不到对应数字的余额，
 * 比没有数字更糟。
 *
 * @param {unknown} payload - 上游 JSON。
 * @returns {object} 归一后的积分文档。
 */
export function normalizeCredits(payload) {
	if (payload === null || typeof payload !== 'object') {
		return { status: 'unavailable', reason: 'malformed-payload' };
	}
	const record = payload;
	const planName = typeof record.planName === 'string' ? record.planName : null;
	const tier = typeof record.tier === 'string' ? record.tier : null;
	const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : null;
	const total = finiteOrUndefined(record.totalCredits);
	const used = finiteOrUndefined(record.usedCredits);
	const unlimited = record.unlimitedCredits === true || (total !== undefined && total < 0);

	const groups = Array.isArray(record.creditGroups)
		? record.creditGroups.map(normalizeGroup).filter((group) => group !== undefined)
		: [];

	// 无积分可算是「没有余额」而不是「读不到」，所以 unlimited 与 total 缺失
	// 都归到无余额，只有连分组都没有时才判为 unavailable。
	if (total === undefined && !unlimited && groups.length === 0) {
		return { status: 'unavailable', reason: 'no-credit-fields' };
	}

	const remaining = unlimited ? undefined : total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined;

	return {
		status: 'available',
		planName,
		tier,
		expiresAt,
		unlimited,
		// 无上限时不透传 total/used：负数是上游的哨兵值，不是一个余额，
		// 让消费者看到「-1 积分」比让它自己猜要好得多。
		...(unlimited || total === undefined ? {} : { total }),
		...(unlimited || used === undefined ? {} : { used }),
		...(remaining === undefined ? {} : { remaining }),
		groups: groups.map((group) => ({ ...group })),
	};
}

/** 从错误里取一句可读原因，绝不带出 token。 */
function reasonOf(error) {
	if (error instanceof OfficeAceError) return error.code;
	if (error instanceof Error) {
		const message = error.message;
		// fetch 的失败原因里可能带上 URL（含端口但不含密钥），长度截断后可用。
		return message.slice(0, 120);
	}
	return String(error).slice(0, 120);
}

/**
 * 发一个 HTTPS GET 并取回响应体。
 *
 * 为什么不用 `fetch`：OfficeAce 的本地 API 用**自签证书**，而签发它的根 CA
 * 不在 Windows 信任库里，Node 的 `fetch`（undici）不接受 per-request 的 `ca`
 * （只认全局 dispatcher），于是稳定报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`。
 * `node:https` 的 `ca` 选项是按请求生效的，不需要动进程级 TLS 配置 ——
 * 设 `NODE_TLS_REJECT_UNAUTHORIZED=0` 会削弱宿主进程里**所有** TLS 连接，
 * 那不是一个插件可以做的决定。
 *
 * @param {{url: string, headers: object, ca?: string, signal?: AbortSignal}} request
 * @returns {Promise<{kind: 'ok', status: number, body: string} | {kind: 'http-error', status: number} | {kind: 'transport', reason: string}>}
 */
async function getJson(request) {
	return new Promise((resolve) => {
		let url;
		try {
			url = new URL(request.url);
		} catch {
			resolve({ kind: 'transport', reason: 'invalid-url' });
			return;
		}

		const options = {
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port || 443,
			path: `${url.pathname}${url.search}`,
			method: 'GET',
			headers: request.headers,
			...(request.ca === undefined ? {} : { ca: request.ca }),
		};

		const req = https.request(options, (res) => {
			const chunks = [];
			let size = 0;
			res.on('data', (chunk) => {
				size += chunk.length;
				// 订阅快照是几千字节的 JSON；给一个宽裕的上限，防止异常响应吃满内存。
				if (size > 1024 * 1024) {
					req.destroy();
					resolve({ kind: 'transport', reason: 'response-too-large' });
					return;
				}
				chunks.push(chunk);
			});
			res.on('end', () => {
				const status = res.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					resolve({ kind: 'http-error', status });
					return;
				}
				resolve({ kind: 'ok', status, body: Buffer.concat(chunks).toString('utf8') });
			});
			res.on('error', (error) => {
				resolve({ kind: 'transport', reason: reasonOf(error) });
			});
		});

		req.on('error', (error) => {
			resolve({ kind: 'transport', reason: reasonOf(error) });
		});
		if (request.signal !== undefined) {
			if (request.signal.aborted) {
				req.destroy();
				resolve({ kind: 'transport', reason: 'aborted' });
				return;
			}
			request.signal.addEventListener('abort', () => {
				req.destroy();
			}, { once: true });
		}
		req.end();
	});
}

/**
 * OfficeAce 本地 API 的只读客户端。
 *
 * 每个读数都重新解析会话身份，因此 OfficeAce 重新登录后下一个读数即自愈，
 * 与模型凭据链的 mtime 失效策略保持同一个思路。
 */
export class OfficeAceCreditsClient {
	#credentialStore;
	#apiBase;

	/**
	 * @param {{credentialStore: () => object, apiBase?: () => string}} options
	 *   `credentialStore` 需提供 `sessionIdentity()`。
	 *   `apiBase` 可覆盖基址（测试用）；缺省取 OfficeAce 默认本地地址。
	 */
	constructor(options) {
		this.#credentialStore = options.credentialStore;
		this.#apiBase = options.apiBase ?? defaultApiBase;
	}

	/** 本地 API 基址。 */
	get apiBase() {
		return this.#apiBase();
	}

	/**
	 * 读一次订阅快照。
	 *
	 * @param {AbortSignal} [signal] - 调用方信号。
	 * @returns {Promise<object>} `normalizeCredits` 的形状，另加 `reachable`
	 *   标记；本地 API 不可达时 `status` 为 `unreachable` 且 `reason` 说明原因。
	 */
	async read(signal) {
		let identity;
		try {
			identity = await this.#credentialStore().sessionIdentity();
		} catch (error) {
			return { status: 'unavailable', reachable: true, reason: reasonOf(error) };
		}
		// 没有会话记录 = OfficeAce 未登录，这与「OfficeAce 没开」是两回事。
		if (identity === null) return { status: 'unavailable', reachable: true, reason: 'not-signed-in' };

		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

		const result = await getJson({
			url: `${this.apiBase}${SUBSCRIPTION_CURRENT_PATH}`,
			headers: {
				'X-Office-Claw-User': identity.userId,
				Authorization: `Bearer ${identity.sessionId}`,
				'X-Office-Claw-Session': identity.sessionId,
				accept: 'application/json',
			},
			ca: this.#rootCert(),
			signal: combined,
		});

		if (result.kind === 'transport') {
			// 本地 API 未监听 / 证书不被接受 / 连接被拒，都落在这里。
			return { status: 'unreachable', reachable: false, reason: result.reason };
		}
		if (result.kind === 'http-error') {
			// 401/403 说明会话身份失效（OfficeAce 侧登出或轮换），归到 unavailable
			// 而不是 unreachable：服务在，只是这份身份不再被接受。
			const reachable = result.status < 500;
			return { status: 'unavailable', reachable, reason: `http-${result.status}` };
		}

		let payload;
		try {
			payload = JSON.parse(result.body);
		} catch {
			return { status: 'unavailable', reachable: true, reason: 'malformed-json' };
		}

		const credits = normalizeCredits(payload);
		return { ...credits, reachable: true };
	}

	/** 本地 API 的根证书 PEM；取不到时返回 undefined（交给系统信任库）。 */
	#rootCert() {
		const store = this.#credentialStore();
		if (typeof store?.apiRootCert !== 'string') return undefined;
		const pem = store.apiRootCert;
		return pem.length > 0 ? pem : undefined;
	}
}

/**
 * 供 Web 设置面板读取的脱敏文档。
 *
 * 与 `normalizeCredits` 的区别：不携带任何身份字段，并把不可读的原因压成
 * 一句稳定措辞，避免把内部 URL/栈信息透到浏览器。
 *
 * @param {object} credits - `OfficeAceCreditsClient.read()` 的返回值。
 * @returns {object} 可直接 JSON 序列化给浏览器的文档。
 */
export function toWebCredits(credits) {
	if (credits.status === 'unreachable') {
		return { status: 'unreachable', message: 'OfficeAce 本地服务未运行' };
	}
	if (credits.status === 'unavailable') {
		return { status: 'unavailable', message: credits.reason === 'not-signed-in' ? 'OfficeAce 未登录' : '积分暂不可读' };
	}
	return {
		status: 'available',
		planName: credits.planName,
		tier: credits.tier,
		expiresAt: credits.expiresAt,
		unlimited: credits.unlimited,
		...(credits.total === undefined ? {} : { total: credits.total }),
		...(credits.used === undefined ? {} : { used: credits.used }),
		...(credits.remaining === undefined ? {} : { remaining: credits.remaining }),
		groups: credits.groups.map((group) => ({
			key: group.key,
			name: group.name,
			kind: group.kind,
			expired: group.expired,
			expiresAt: group.expiresAt,
			unlimited: group.unlimited,
			...(group.remaining === undefined ? {} : { remaining: group.remaining }),
			...(group.total === undefined ? {} : { total: group.total }),
		})),
	};
}
