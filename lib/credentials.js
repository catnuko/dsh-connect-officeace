/**
 * OfficeAce 凭据读取：复刻 OfficeAce 自身的凭据链，不新增任何明文落盘。
 *
 * OfficeAce 有两代凭据存储，本模块同时支持，运行时自动探测：
 *
 * 【新一代 · 1.3.4+】SQLite KV 存储（当前实测路径）
 *   `<install>/data/storage.sqlite` 的 `oc_kv_string` 表中，
 *   key = `office-claw:oc:session:user:<userId>`，value 是 JSON 会话记录。
 *   会话记录里的 `providerState.modelInfo.model_auth_info` 直接给出
 *   `model_app_key` / `model_app_secret`（**明文**，无额外加密层）。
 *   会话所属用户取自 `~/.office-claw/connector-owner.local.json` 的 `ownerUserId`。
 *
 * 【旧一代 · 1.3.3 及更早】DPAPI + AES-256-GCM 文件存储（保留回退）
 *   1. `<install>/packages/api/.config/secure-config-nodejs/.oauth-profile-encryption-key`
 *      是 DPAPI(CurrentUser) 包裹的安装密钥（`OC-DPAPI-1\n` 前缀 + base64）。
 *   2. `OfficeAceServiceHost.exe --mode dpapi-unprotect`（stdin base64 → stdout base64）
 *      解出安装密钥明文。
 *   3. `sha256(安装密钥)` 作为 AES-256-GCM 密钥，解密同目录的 `oauth-<userId>.json`
 *      （`{version, alg, iv, tag, data}`，字段均为 base64url）。
 *
 * 两代最终都归一到同一个 `modelInfo` 形状，再组装：
 *   - `modelInfo.model_auth_info.{model_app_key,model_app_secret}` → Basic 头
 *   - `modelInfo.model_api_url_base` → 端点基址（**每用户下发，绝不硬编码**）
 *
 * 设计要点：**不长期缓存**。以存储文件的 mtime 作为缓存签名，任一变化即重新解析，
 * 这样 OfficeAce 轮换令牌后本插件下一个请求即可自愈。
 *
 * 本文件不打印、不落盘、不外发任何密钥取值。
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** DPAPI 包裹文本的固定前缀，与 OfficeAce `scripts/lib/dpapi.mjs` 一致。 */
const DPAPI_MAGIC = 'OC-DPAPI-1\n';
/** 旧一代：相对安装根的安全配置目录。 */
const SECURE_SEGMENTS = ['packages', 'api', '.config', 'secure-config-nodejs'];
/** 可用的 DPAPI 助手可执行文件（打包版优先，兼容旧命名）。 */
const HELPER_NAMES = ['OfficeAceServiceHost.exe', 'OfficeClawServiceHost.exe'];
/** 新一代：会话 KV 的 key 前缀。 */
const SESSION_KEY_PREFIX = 'office-claw:oc:session:user:';

/** 新一代：按 session id 索引的会话 KV 前缀。 */
const SESSION_ID_KEY_PREFIX = 'office-claw:oc:session:id:';

/**
 * OfficeAce 本地 API 的默认端口。`api-instance-lease` 记录里也带这个值，
 * 但那是运行时租约，OfficeAce 退出后会消失，所以常量只作为兜底。
 */
export const DEFAULT_API_PORT = 3004;

/** 本地 API 的默认基址（HTTPS + 自签证书，插件侧必须忽略证书校验）。 */
export function defaultApiBase() {
	const override = process.env.OFFICE_CLAW_API_URL;
	if (typeof override === 'string' && override.trim().length > 0) {
		return override.trim().replace(/\/+$/, '');
	}
	return `https://127.0.0.1:${DEFAULT_API_PORT}`;
}

/** 带稳定错误码的凭据错误，便于上层映射为 DSH 的失败码。 */
export class OfficeAceError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.name = 'OfficeAceError';
		this.code = code;
	}
}

/** OfficeAce 默认安装根：`%LOCALAPPDATA%\Programs\OfficeAce`。 */
export function defaultInstallRoot() {
	const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
	return join(local, 'Programs', 'OfficeAce');
}

/** OfficeAce 默认用户数据根：`~/.office-claw`。 */
export function defaultDataRoot() {
	return join(homedir(), '.office-claw');
}

/**
 * 复刻 OfficeAce 的 `normalizeBaseUrl`：补 `https://`，并以 `/v2` 结尾。
 * 基址是**每用户**下发的，绝不能硬编码。
 */
export function normalizeBaseUrl(raw) {
	const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
	if (trimmed.length === 0) {
		throw new OfficeAceError('OfficeAce profile has no model_api_url_base', 'MISSING_BASE_URL');
	}
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	return withScheme.endsWith('/v2') ? withScheme : `${withScheme}/v2`;
}

function mtimeOf(path) {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return -1;
	}
}

function readText(path) {
	try {
		return readFileSync(path, 'utf8');
	} catch (error) {
		throw new OfficeAceError(`OfficeAce credential file is unreadable: ${path}`, 'CREDENTIAL_UNREADABLE', { cause: error });
	}
}

/**
 * 解析并缓存 OfficeAce 的模型凭据。
 *
 * 同机同用户下的任意进程都能读到这些凭据 —— 这正是本插件能工作的前提，
 * 也是该凭据的唯一边界（不防同用户进程）。
 */
export class OfficeAceCredentials {
	#installRoot;
	#dataRoot;
	#profileFile;
	#storeFile;
	#cache;

	constructor(options = {}) {
		this.#installRoot = options.installRoot ?? defaultInstallRoot();
		this.#dataRoot = options.dataRoot ?? defaultDataRoot();
		this.#profileFile = options.profileFile;
		this.#storeFile = options.storeFile;
	}

	get installRoot() {
		return this.#installRoot;
	}

	get dataRoot() {
		return this.#dataRoot;
	}

	/** 旧一代安全配置目录。 */
	get secureDir() {
		return join(this.#installRoot, ...SECURE_SEGMENTS);
	}

	/** 旧一代安装密钥文件。 */
	get keyFile() {
		return join(this.secureDir, '.oauth-profile-encryption-key');
	}

/** 新一代 SQLite KV 存储文件。 */
	get storeFile() {
		if (this.#storeFile !== undefined) return this.#storeFile;
		// OfficeAce 把数据放在安装根下的 `data/`（可用 OFFICE_CLAW_DATA_DIR 覆盖）。
		const override = process.env.OFFICE_CLAW_DATA_DIR;
		if (typeof override === 'string' && override.trim().length > 0) {
			return join(override.trim(), 'storage.sqlite');
		}
		return join(this.#installRoot, 'data', 'storage.sqlite');
	}

	/**
	 * 本地 API 的自签根证书。本地 API 只接受 HTTPS + 这把 CA 签发的证书，
	 * 而该 CA 不在 Windows 信任库里，所以客户端必须显式把它作为 `ca` 传入。
	 * @returns {string} PEM 文本；文件不存在时返回空串。
	 */
	get apiRootCert() {
		const candidates = [
			join(this.#installRoot, '.office-claw', 'certs', 'root-ca.pem'),
			join(this.#dataRoot, 'certs', 'root-ca.pem'),
		];
		for (const candidate of candidates) {
			try {
				const text = readFileSync(candidate, 'utf8');
				if (text.includes('BEGIN CERTIFICATE')) return text;
			} catch {
				// 试下一个候选
			}
		}
		return '';
	}

	/** 当前用户 id：优先 `connector-owner.local.json` 的 ownerUserId。 */
	#ownerUserId() {
		const ownerFile = join(this.#dataRoot, 'connector-owner.local.json');
		if (!existsSync(ownerFile)) return null;
		try {
			const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
			const userId = owner?.ownerUserId;
			return typeof userId === 'string' && userId.length > 0 ? userId : null;
		} catch {
			return null;
		}
	}

	/** DPAPI 助手路径；找不到即抛错，避免退化为不安全的 PowerShell 回退。 */
	#helper() {
		for (const name of HELPER_NAMES) {
			const candidate = join(this.#installRoot, name);
			if (existsSync(candidate)) return candidate;
		}
		throw new OfficeAceError(`OfficeAce DPAPI helper not found under ${this.#installRoot}`, 'HELPER_MISSING');
	}

	/** DPAPI 解包：stdin 传 base64，stdout 收 base64。 */
	#dpapiUnprotect(blob) {
		const body = blob.startsWith(DPAPI_MAGIC) ? blob.slice(DPAPI_MAGIC.length) : blob;
		const helper = this.#helper();
		let stdout;
		try {
			stdout = execFileSync(helper, ['--mode', 'dpapi-unprotect'], {
				input: `${body.trim()}\n`,
				encoding: 'utf8',
				windowsHide: true,
				maxBuffer: 4 * 1024 * 1024,
			});
		} catch (error) {
			throw new OfficeAceError('OfficeAce DPAPI helper failed to unprotect the install key', 'DPAPI_FAILED', { cause: error });
		}
		return Buffer.from(stdout.trim(), 'base64').toString('utf8');
	}

	/**
	 * 新一代：从 SQLite KV 读取当前用户的会话记录。
	 * 返回 `{ profile, expiresAt, userId }`，未登录时返回 null。
	 */
	async #readSessionFromStore() {
		const storeFile = this.storeFile;
		if (!existsSync(storeFile)) return null;

		let DatabaseSync;
		try {
			({ DatabaseSync } = await import('node:sqlite'));
		} catch (error) {
			throw new OfficeAceError('This Node runtime has no node:sqlite; cannot read the OfficeAce session store', 'STORE_UNSUPPORTED', { cause: error });
		}

		let db;
		try {
			db = new DatabaseSync(storeFile, { readOnly: true });
		} catch (error) {
			throw new OfficeAceError(`OfficeAce session store is unreadable: ${storeFile}`, 'CREDENTIAL_UNREADABLE', { cause: error });
		}

		try {
			const owner = this.#ownerUserId();
			const rows = db
				.prepare('SELECT key, value FROM oc_kv_string WHERE key LIKE ?')
				.all(`${SESSION_KEY_PREFIX}%`);
			if (rows.length === 0) return null;

			let row = null;
			if (owner !== null) {
				row = rows.find((candidate) => candidate.key === `${SESSION_KEY_PREFIX}${owner}`) ?? null;
			}
			if (row === null) row = rows.length === 1 ? rows[0] : null;
			if (row === null) return null;

			let session;
			try {
				session = JSON.parse(row.value);
			} catch (error) {
				throw new OfficeAceError('OfficeAce session record is not valid JSON', 'PROFILE_INVALID', { cause: error });
			}
			// providerState 与旧一代解密后的 profile 形状一致，便于共用提取逻辑。
			const profile = session?.providerState;
			if (profile === null || typeof profile !== 'object') return null;
			return {
				profile,
				expiresAt: typeof session.expiresAt === 'string' ? session.expiresAt : null,
				userId: typeof session.userId === 'string' ? session.userId : owner,
			};
		} finally {
			try {
				db.close();
			} catch {
				// 只读句柄，关闭失败无碍
			}
		}
	}

	/** 旧一代：定位当前用户的 OAuth profile 文件。 */
	#legacyProfilePath() {
		if (this.#profileFile !== undefined) return this.#profileFile;

		const owner = this.#ownerUserId();
		if (owner !== null) {
			const candidate = join(this.secureDir, `oauth-${encodeURIComponent(owner)}.json`);
			if (existsSync(candidate)) return candidate;
		}

		let entries;
		try {
			entries = readdirSync(this.secureDir);
		} catch (error) {
			throw new OfficeAceError(`OfficeAce secure config directory is unreadable: ${this.secureDir}`, 'CREDENTIAL_UNREADABLE', { cause: error });
		}
		const matches = entries.filter((name) => name.startsWith('oauth-') && name.endsWith('.json'));
		if (matches.length === 0) {
			throw new OfficeAceError('OfficeAce has no stored OAuth profile; sign in to OfficeAce first', 'NOT_SIGNED_IN');
		}
		return join(this.secureDir, matches[0]);
	}

	/** 旧一代：解密 OAuth profile。 */
	#decrypt(profilePath, installSecret) {
		let payload;
		try {
			payload = JSON.parse(readText(profilePath));
		} catch (error) {
			throw new OfficeAceError('OfficeAce OAuth profile is not valid JSON', 'PROFILE_INVALID', { cause: error });
		}
		if (payload?.alg !== 'aes-256-gcm') {
			throw new OfficeAceError(`Unsupported OfficeAce profile algorithm: ${String(payload?.alg)}`, 'PROFILE_UNSUPPORTED');
		}
		const key = createHash('sha256').update(installSecret).digest();
		try {
			const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64url'));
			decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
			const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64url')), decipher.final()]);
			return JSON.parse(plain.toString('utf8'));
		} catch (error) {
			throw new OfficeAceError('OfficeAce OAuth profile failed to decrypt (key rotated?)', 'PROFILE_DECRYPT_FAILED', { cause: error });
		}
	}

	/**
	 * 解析当前可用的模型凭据。
	 * @returns {Promise<{baseUrl: string, authorization: string, expiresAt: string | null, accountId: string | null, store: string}>}
	 */
	async resolve() {
		const storeFile = this.storeFile;
		const legacyKeyFile = this.keyFile;
		const signature = `${mtimeOf(storeFile)}:${mtimeOf(`${storeFile}-wal`)}:${mtimeOf(legacyKeyFile)}`;
		if (this.#cache !== undefined && this.#cache.signature === signature) return this.#cache.snapshot;

		let profile = null;
		let expiresAt = null;
		let accountId = null;
		let store = null;

		// 优先新一代 SQLite 存储；未登录/不存在时回退旧一代 DPAPI 文件。
		if (existsSync(storeFile)) {
			const session = await this.#readSessionFromStore();
			if (session !== null) {
				profile = session.profile;
				expiresAt = session.expiresAt;
				accountId = typeof profile?.accountId === 'string' ? profile.accountId : null;
				store = 'sqlite';
			}
		}

		if (profile === null) {
			if (!existsSync(legacyKeyFile)) {
				throw new OfficeAceError(
					`OfficeAce has no usable credential store; sign in to OfficeAce first (looked for ${storeFile})`,
					'NOT_SIGNED_IN',
				);
			}
			const profilePath = this.#legacyProfilePath();
			const installSecret = this.#dpapiUnprotect(readText(legacyKeyFile));
			profile = this.#decrypt(profilePath, installSecret);
			expiresAt = typeof profile?.credential?.expires_at === 'string' ? profile.credential.expires_at : null;
			accountId = typeof profile?.accountId === 'string' ? profile.accountId : null;
			store = 'dpapi';
		}

		const modelInfo = profile?.modelInfo;
		const auth = modelInfo?.model_auth_info;
		const appKey = auth?.model_app_key;
		const appSecret = auth?.model_app_secret;
		if (typeof appKey !== 'string' || typeof appSecret !== 'string' || appKey.length === 0 || appSecret.length === 0) {
			throw new OfficeAceError('OfficeAce profile has no model gateway credentials; re-open OfficeAce to refresh the session', 'MISSING_MODEL_AUTH');
		}

		const snapshot = {
			baseUrl: normalizeBaseUrl(modelInfo?.model_api_url_base),
			// 网关只认 Basic（Bearer maas_api_key 实测 401）。
			authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString('base64')}`,
			expiresAt,
			accountId,
			store,
		};
		this.#cache = { signature, snapshot };
		return snapshot;
	}

	/**
	 * 读取本地 API 所需的会话身份：`{ sessionId, userId, expiresAt }`。
	 *
	 * OfficeAce 的 Web UI 用三个自定义头调它自己的本地 API
	 * （`X-Office-Claw-User` / `Authorization: Bearer` / `X-Office-Claw-Session`），
	 * 三者的取值全部来自同一份会话记录，因此外部进程可以复用同一份身份去读
	 * 只读端点（订阅/积分）。会话记录同时以 user 维度和 id 维度各存一份，
	 * 内容一致，这里优先取 user 维度。
	 *
	 * 与 `resolve()` 分开：模型凭据与会话身份的生命周期不同（前者按 mtime
	 * 缓存，后者随每次登录轮换），且 `resolve()` 的旧一代 DPAPI 回退链路里
	 * 根本没有 sessionId，不能混在一个快照里。
	 *
	 * @returns {Promise<{sessionId: string, userId: string, expiresAt: string | null} | null>}
	 *   未登录时返回 null。
	 */
	async sessionIdentity() {
		const storeFile = this.storeFile;
		if (!existsSync(storeFile)) return null;

		let DatabaseSync;
		try {
			({ DatabaseSync } = await import('node:sqlite'));
		} catch (error) {
			throw new OfficeAceError('This Node runtime has no node:sqlite; cannot read the OfficeAce session store', 'STORE_UNSUPPORTED', { cause: error });
		}

		let db;
		try {
			db = new DatabaseSync(storeFile, { readOnly: true });
		} catch (error) {
			throw new OfficeAceError(`OfficeAce session store is unreadable: ${storeFile}`, 'CREDENTIAL_UNREADABLE', { cause: error });
		}

		try {
			const rows = db
				.prepare('SELECT key, value FROM oc_kv_string WHERE key LIKE ?')
				.all(`${SESSION_KEY_PREFIX}%`);
			const byId = db
				.prepare('SELECT key, value FROM oc_kv_string WHERE key LIKE ?')
				.all(`${SESSION_ID_KEY_PREFIX}%`);
			const candidates = [...rows, ...byId];
			const owner = this.#ownerUserId();
			for (const row of candidates) {
				let session;
				try {
					session = JSON.parse(row.value);
				} catch {
					continue;
				}
				if (session === null || typeof session !== 'object') continue;
				const sessionId = session.sessionId;
				const userId = session.userId;
				if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
				if (typeof userId !== 'string' || userId.length === 0) continue;
				// 多账号时只认当前 owner 的那一份，避免读到别的登录态。
				if (owner !== null && userId !== owner && !row.key.endsWith(owner)) continue;
				return {
					sessionId,
					userId,
					expiresAt: typeof session.expiresAt === 'string' ? session.expiresAt : null,
				};
			}
			return null;
		} finally {
			try {
				db.close();
			} catch {
				// 只读句柄，关闭失败无碍
			}
		}
	}

	/** 只读诊断：报告各环节是否就绪，绝不输出密钥取值。 */
	async diagnose() {
		const storeFile = this.storeFile;
		const report = {
			installRoot: this.#installRoot,
			storeFile,
			storeFilePresent: existsSync(storeFile),
			secureDir: this.secureDir,
			helperPresent: false,
			keyFilePresent: existsSync(this.keyFile),
			profilePresent: false,
			store: null,
			signedIn: false,
			baseUrl: null,
			accountId: null,
			expiresAt: null,
			sessionPresent: false,
			reason: null,
		};
		try {
			this.#helper();
			report.helperPresent = true;
		} catch {
			// 新一代存储不需要 DPAPI 助手，这里仅作信息记录
		}
		try {
			const snapshot = await this.resolve();
			report.signedIn = true;
			report.store = snapshot.store;
			report.baseUrl = snapshot.baseUrl;
			report.accountId = snapshot.accountId;
			report.expiresAt = snapshot.expiresAt;
		} catch (error) {
			report.reason = `${error.code ?? 'UNKNOWN'}: ${error.message}`;
		}
		try {
			const identity = await this.sessionIdentity();
			report.sessionPresent = identity !== null;
		} catch (error) {
			// 会话身份只服务于积分读数，缺失不应污染模型凭据的诊断结论。
			if (report.reason === null) report.reason = `session: ${error.code ?? 'UNKNOWN'}`;
		}
		return report;
	}
}