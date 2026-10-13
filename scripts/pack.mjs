/**
 * 打包 `dsh-connect-officeace` 为可被 `plugin_manager install_bundle` 安装的 tarball。
 *
 * 为什么必须自己打包而不是直接安装目录：
 *   `install_bundle` 对本地**目录**会写成 `link:` 依赖，pnpm 生成 junction，
 *   插件真实路径落在 profile 树之外，DSH 的模块解析层把它归类为 linked layer，
 *   于是 `@deepseek-ai/dsh-llm` 等 dsh 自带的裸包名解析失败（ERR_MODULE_NOT_FOUND），
 *   模块求值直接 reject → 无 fiber → 只报一句不透明的 "failed to import"。
 *   从 `.tgz` 安装时 pnpm 会在 profile 的 node_modules 下建**真实目录**，与
 *   Trae/Qoder 一致，裸包名即可正常解析。
 *
 * 为什么 tarball 里必须含 `package/package.json`：
 *   pnpm 从 tarball 内的 `package/package.json` 推断依赖别名。缺少它会直接
 *   报 `[ERR_PNPM_INVALID_DEPENDENCY_NAME] Refusing to place a dependency under
 *   ... with the invalid alias "<absolute tarball path>"`。
 *
 * 用法：node scripts/pack.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const distDir = path.join(root, 'dist');
const stageDir = path.join(distDir, 'stage');
const packageDir = path.join(stageDir, 'package');
const tarball = path.join(distDir, `${manifest.name}-${manifest.version}.tgz`);

fs.rmSync(stageDir, { recursive: true, force: true });
fs.rmSync(tarball, { force: true });
fs.mkdirSync(packageDir, { recursive: true });

// `files` 决定发布内容；`package.json` 必须始终在内（pnpm 靠它推断别名）。
const included = new Set(['package.json', ...(manifest.files ?? [])]);
for (const entry of included) {
	const source = path.join(root, entry);
	if (!fs.existsSync(source)) {
		throw new Error(`pack: manifest entry is missing: ${entry}`);
	}
	fs.cpSync(source, path.join(packageDir, entry), { recursive: true });
}

// pnpm 会剥掉一层前导路径，所以 tarball 顶层必须是 `package/`。
execFileSync('tar.exe', ['-czf', tarball, '-C', stageDir, 'package'], { stdio: 'inherit' });
fs.rmSync(stageDir, { recursive: true, force: true });

const listing = execFileSync('tar.exe', ['-tzf', tarball], { encoding: 'utf8' });
console.log(`packed ${tarball}`);
console.log(listing.trim());