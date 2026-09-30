import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
//#region src/index.ts
/**
* whaletv-workbench Host half (Node): the workbench state, config save,
* one-click update, skills management, and follow-up-to-agent routes
* mounted on ctx.webServer plus a `whaletv-workbench` settings namespace.
*
* Routes (all under `/whaletv/workbench` served by one prefix seat):
*   GET  /state              → version / git facts / entry config
*   POST /config             → validate + persist workbench.json
*   POST /update             → git pull --ff-only → (changed) pnpm install
*                              → pnpm run bundle → ctx.clientModules.rebuilt
*   GET  /update/check       → fetch + ahead/behind + incoming commits
*   GET  /update/history     → rolling update-attempt log (updates.json)
*   POST /update/skip        → mark the upstream head as skipped
*   POST /update/rollback    → reset to the last update's before-SHA + rebuild
*   GET  /usage              → launch-count ledger (最近使用 rail)
*   POST /usage/record       → bump one item's launch counter
*   GET  /health             → reachability probe for every entry
*   GET  /icon?url=<origin>  → cached per-origin favicon proxy
*   GET  /skills             → invocation-neutral summaries from ctx.skills
*   POST /skills/install     → write a workbench-owned skill into
*                              $DSH_HOME/skills/<name>/SKILL.md and record it
*   POST /skills/import      → shallow-clone a git repo and copy the named
*                              skill body (bundle or flat markdown) into
*                              $DSH_HOME/skills/<name>/
*   POST /skills/remove      → remove a workbench-owned skill's dir
*   POST /skills/update      → re-clone the recorded origin and apply changes
*   POST /session/followup   → ctx.agents.get(sessionId).followup(message)
*                              — the modern replacement for
*                              clipboard-copy + startSession pairing.
*
* The browser half calls these routes with same-origin fetch. The Host half
* stays intentionally thin and stable so most updates only reload the client
* bundle; when a pulled commit touches Host code, `needRestart` tells the
* user to restart dsh.
*
* @module whaletv-workbench
*/
const name = "whaletv-workbench";
const Config = z.object({
	gitRemote: z.string().default("").volatile(),
	customSkillDirs: z.array(z.string()).default([]).volatile(),
	updateRepo: z.string().default("KK-Irving/whaletv-workbench").volatile(),
	installedSkills: z.array(z.string()).default([]),
	skippedHead: z.string().default("")
});
/**
* Host services this plugin uses through ctx. `settings` (dsh SettingsForms
* on ≥ 0.1.7) is used once in apply() to turn off the auto-generated config
* page; the plugin's own bookkeeping lives in its JSON state documents
* instead of the settings document. The settings namespace is this plugin's
* profile entry id (`whaletv-workbench`, see cordis.patch.yml) — referenced
* by the generated page, not by this code.
*/
const inject = [
	"webServer",
	"clientModules",
	"skills",
	"agents",
	"settings",
	"pluginManager"
];
/** Plugin id — matches the package name and the client bundle graph row. */
const CLIENT_ID = "whaletv-workbench";
/** This package's root directory (lib/index.js → lib → package root). */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/**
* All workbench routes live under this prefix. One `kind: 'prefix'`
* registration owns dispatch on the sub-path, reducing seven separate
* registrations to a single disposer.
*/
const ROUTE_PREFIX = "/whaletv/workbench";
/** Output captured per update step, truncated so JSON responses stay small. */
const MAX_STEP_OUTPUT = 32e3;
/** Upper bounds for the payload the two JSON write routes accept. */
const MAX_CONFIG_BYTES = 524288;
const MAX_SKILL_BYTES = 262144;
const MAX_GROUPS = 50;
const MAX_ITEMS_PER_GROUP = 200;
/** Skill name must match dsh-skill's kebab-case identifier rule. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
* Git URL surface accepted by the import route: HTTP(S) and SSH forms only.
* File paths (`file://`, plain absolute paths) are rejected — importing from
* a local directory would let anyone with route access clone off-disk stuff
* into $DSH_HOME/skills. Ref (branch/tag) is validated separately.
*/
const GIT_URL_PATTERN = /^(https?:\/\/|git@[^\s:]+:|ssh:\/\/)/;
/** Branch / tag / short SHA — no shell metacharacters, no path separators. */
const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const execFileAsync = promisify(execFile);
/**
* pnpm 11 propagates its own workspace flags as `NPM_CONFIG_*` env vars
* (chiefly `NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS`), which npm 11
* warns about as an unknown env config. Strip the known offenders before
* spawning any child so the noise never leaks into the plugin's captured
* output. Only pnpm's own subprocesses need this var; dropping it at the
* boundary does not disable the pnpm feature — pnpm still honors its
* pnpm-workspace.yaml / .npmrc config sources inside the child.
*
* Also force git into non-interactive mode: our plugin subprocess has no
* tty, so any credential prompt (git-credential-manager, ask-pass) hangs or
* crashes. Setting `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=Never` makes
* git fail fast with a readable "could not read Username" message when a
* private repo needs auth that isn't already cached.
*/
const NOISY_NPM_ENV_VARS = ["NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS", "npm_config_manage_package_manager_versions"];
function sanitizedEnv() {
	const env = { ...process.env };
	for (const key of NOISY_NPM_ENV_VARS) delete env[key];
	env.GIT_TERMINAL_PROMPT = "0";
	env.GCM_INTERACTIVE = "Never";
	return env;
}
/**
* Recognize git errors that come from "no cached credentials for a private
* repo" and the OAuth 2.0 `invalid_client` family enterprise GitHub returns
* when SSO / OIDC rejects the HTTP Basic auth git tried. These are the
* exact strings git / GCM / the OAuth server emit. When one hits we
* replace the raw output with an actionable message pointing at the two
* viable workarounds (SSH with configured keys, or an SSO-authorized PAT).
*/
const GIT_AUTH_ERROR_PATTERN = /could not read Username|Authentication failed|Interactive logon|Invalid username or password|fatal: unable to access|Permission denied \(publickey\)|Client authentication failed|unsupported authentication method|unknown client|invalid_client/i;
function translateGitError(url, message) {
	if (!GIT_AUTH_ERROR_PATTERN.test(message)) return message;
	return [
		/Client authentication failed|unsupported authentication method|unknown client|invalid_client/i.test(message) ? `仓库 ${url} 拒绝了 HTTP 基本认证 —— 这个 host 用了 OAuth/SSO 保护（企业版 GitHub / GitLab 常见）。` : `无法访问仓库（认证失败）：${url}`,
		"",
		"git 命令行认证走不通 OAuth 流程；工作台子进程也没有交互终端。只有下面两条能跑通：",
		" 1. 改用 SSH 地址（git@host:owner/repo.git）+ 事先配好的 SSH key —— 完全绕开 HTTPS/OAuth。",
		" 2. 生成 Personal Access Token 并在企业 GHE 后台点「Enable SSO」授权该 token 通过 SSO；然后用 https://<user>:<token>@host/... 格式填进 URL 框。",
		"",
		`原始错误：${message.split("\n").slice(0, 6).join(" ｜ ")}`
	].join("\n");
}
/** $DSH_HOME resolution, matching what the launcher and other bundles use. */
const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), ".dsh");
/** dsh-skill-filesystem user-dsh root (rank 400). Written by the install route. */
const USER_DSH_SKILLS_DIR = join(DSH_HOME, "skills");
/** Workbench-owned state directory (installed-skill registry, workbench.json). */
const WORKBENCH_STATE_DIR = join(DSH_HOME, "whaletv-workbench");
const WORKBENCH_CONFIG_PATH = join(WORKBENCH_STATE_DIR, "workbench.json");
/** Staging root for shallow git clones during skill import; entries are removed after copy. */
const IMPORT_STAGING_DIR = join(WORKBENCH_STATE_DIR, ".staging");
/** Legacy config location — read once for backward-compat, then migrated. */
const LEGACY_CONFIG_PATH = join(PACKAGE_DIR, "config", "workbench.json");
/** Rolling self-update history (roadmap P1-9): the last N update attempts. */
const UPDATE_HISTORY_PATH = join(WORKBENCH_STATE_DIR, "updates.json");
const MAX_HISTORY_ENTRIES = 20;
/** How many incoming commits the update checker lists. */
const MAX_CHECK_COMMITS = 20;
/** SHA accepted by the skip route: short (≥7) or full hex. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
/**
* Launch-usage ledger (roadmap P2-12): `{ [itemId]: { count, lastUsed } }`,
* feeding the panel's 最近使用 rail. Capped by lastUsed recency.
*/
const USAGE_PATH = join(WORKBENCH_STATE_DIR, "usage.json");
const MAX_USAGE_ENTRIES = 500;
/**
* Skill versioning records (roadmap P3-20): one line per workbench-installed
* skill with its Git origin / SHA / sub-path, enabling the per-skill
* "检查更新" (P3-21). Plain Host-owned JSON — not a settings field — so the
* settings schema stays flat and old user layers never need migrating.
*/
const INSTALLED_RECORDS_PATH = join(WORKBENCH_STATE_DIR, "installed-skills.json");
/**
* Small update-checker state (roadmap P1-10): the skipped upstream head.
* Host-owned JSON for the same reason as installed-skills.json — the 0.1.7
* settings document is schema-projected from Config and is no place for
* runtime bookkeeping.
*/
const UPDATE_STATE_PATH = join(WORKBENCH_STATE_DIR, "update-state.json");
/** Per-probe timeout for the reachability checker (roadmap P2-16). */
const HEALTH_TIMEOUT_MS = 5e3;
/** Favicon cache (roadmap P2-17): per-origin icons under the state dir. */
const ICON_DIR = join(WORKBENCH_STATE_DIR, "icons");
const ICON_MAX_BYTES = 524288;
/**
* Hostnames the favicon proxy refuses: loopback / link-local / RFC1918
* literals and localhost. A local dashboard could otherwise be talked into
* fetching intranet URLs. DNS rebinding is out of scope for a 127.0.0.1
* tool (documented tradeoff, mirrors the git-import URL posture).
*/
const PRIVATE_HOST_PATTERN = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|\[fc|\[fd|\[fe80)/i;
/**
* Resolve spawn options for this platform: npm/pnpm are .cmd shims on
* Windows and must run through the shell; git.exe spawns directly.
* @param command - bare command name (git / pnpm).
* @returns the execFile options for one invocation.
*/
function spawnOptions(command) {
	return { shell: process.platform === "win32" && (command === "pnpm" || command === "npm") };
}
/**
* Run one command; returns merged trimmed output. Defaults cwd to this
* plugin's package dir (where git operations for self-update live), but the
* skill-import route overrides cwd so clones happen in the staging root.
*/
async function run(command, args, cwd = PACKAGE_DIR) {
	try {
		const result = await execFileAsync(command, args, {
			cwd,
			windowsHide: true,
			maxBuffer: 4194304,
			env: sanitizedEnv(),
			...spawnOptions(command)
		});
		return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	} catch (error) {
		const failure = error;
		const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
		const detail = failure.message ?? String(error);
		throw new Error(output === "" ? detail : `${output}\n${detail}`);
	}
}
/** git output, or undefined when the directory is not a git work tree. */
async function git(args) {
	try {
		return await run("git", args);
	} catch {
		return;
	}
}
/** Trim one step's captured output to the response budget. */
function truncate(output) {
	if (output.length <= MAX_STEP_OUTPUT) return output;
	return `${output.slice(0, MAX_STEP_OUTPUT)}\n… (已截断)`;
}
/**
* Read the entry config: `$DSH_HOME/whaletv-workbench/workbench.json` when
* present, falling back to the legacy plugin-dir path once (with implicit
* migration to the new location), then the shipped template. A broken file
* renders as a single error group so the panel remains usable.
*/
function readConfig() {
	const examplePath = join(PACKAGE_DIR, "config", "workbench.example.json");
	if (existsSync(WORKBENCH_CONFIG_PATH)) return parseConfigFile(WORKBENCH_CONFIG_PATH);
	if (existsSync(LEGACY_CONFIG_PATH)) {
		const parsed = parseConfigFile(LEGACY_CONFIG_PATH);
		try {
			writeConfig(parsed);
		} catch {}
		return parsed;
	}
	if (existsSync(examplePath)) return parseConfigFile(examplePath);
	return { groups: [] };
}
function parseConfigFile(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.groups)) throw new Error(`${basename(path)} 必须是 { "groups": [...] } 结构`);
		return parsed;
	} catch (error) {
		return { groups: [{
			id: "broken",
			title: "配置读取失败",
			items: [{
				id: "broken",
				title: String(error),
				description: `检查 ${path}`
			}]
		}] };
	}
}
/**
* Collect a request body with a size cap. Resolves the parsed JSON; rejects
* with a readable message on oversize / stream errors / malformed JSON.
* @param req - the incoming request.
* @param maxBytes - upper bound for this specific request.
*/
function readJsonBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		const fail = (message) => {
			if (settled) return;
			settled = true;
			reject(new Error(message));
		};
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				fail(`请求体过大（超过 ${maxBytes / 1024}KB）`);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(/* @__PURE__ */ new Error("请求体不是合法的 JSON"));
			}
		});
		req.on("error", () => {
			fail("读取请求体失败");
		});
	});
}
/**
* Trim a string field: non-strings and blank strings collapse to undefined
* (the field is dropped from the persisted item).
*/
function cleanString(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Validate and normalize a raw WorkbenchConfig payload.
*/
function sanitizeConfig(raw) {
	if (raw === null || typeof raw !== "object" || !Array.isArray(raw.groups)) throw new Error("配置必须是 { \"groups\": [...] } 结构");
	const rawGroups = raw.groups;
	if (rawGroups.length > MAX_GROUPS) throw new Error(`分组数量超过上限（${MAX_GROUPS}）`);
	const seenGroupIds = /* @__PURE__ */ new Set();
	const seenItemIds = /* @__PURE__ */ new Set();
	return { groups: rawGroups.map((rawGroup, groupIndex) => {
		if (rawGroup === null || typeof rawGroup !== "object") throw new Error(`第 ${groupIndex + 1} 个分组不是对象`);
		const group = rawGroup;
		const id = cleanString(group.id);
		const title = cleanString(group.title);
		if (id === void 0) throw new Error(`第 ${groupIndex + 1} 个分组缺少 id`);
		if (title === void 0) throw new Error(`分组 ${id} 缺少标题`);
		if (seenGroupIds.has(id)) throw new Error(`分组 id 重复：${id}`);
		seenGroupIds.add(id);
		if (!Array.isArray(group.items)) throw new Error(`分组「${title}」的 items 必须是数组`);
		if (group.items.length > MAX_ITEMS_PER_GROUP) throw new Error(`分组「${title}」的条目数量超过上限（${MAX_ITEMS_PER_GROUP}）`);
		return {
			id,
			title,
			items: group.items.map((rawItem, itemIndex) => {
				if (rawItem === null || typeof rawItem !== "object") throw new Error(`分组「${title}」第 ${itemIndex + 1} 个条目不是对象`);
				const item = rawItem;
				const itemId = cleanString(item.id);
				const itemTitle = cleanString(item.title);
				if (itemId === void 0) throw new Error(`分组「${title}」第 ${itemIndex + 1} 个条目缺少 id`);
				if (itemTitle === void 0) throw new Error(`分组「${title}」第 ${itemIndex + 1} 个条目缺少标题`);
				if (seenItemIds.has(itemId)) throw new Error(`条目 id 重复：${itemId}`);
				seenItemIds.add(itemId);
				const cleaned = {
					id: itemId,
					title: itemTitle
				};
				const description = cleanString(item.description);
				const url = cleanString(item.url);
				const path = cleanString(item.path);
				const prompt = cleanString(item.prompt);
				if (description !== void 0) cleaned.description = description;
				if (url !== void 0) cleaned.url = url;
				if (path !== void 0) cleaned.path = path;
				if (prompt !== void 0) cleaned.prompt = prompt;
				return cleaned;
			})
		};
	}) };
}
/** Persist the workbench.json atomically (tmp file + rename). */
function writeConfig(config) {
	mkdirSync(WORKBENCH_STATE_DIR, { recursive: true });
	const tmp = `${WORKBENCH_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	try {
		renameSync(tmp, WORKBENCH_CONFIG_PATH);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}
/** Read this package's version from its manifest. */
function readVersion() {
	try {
		return JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
}
/** Assemble the GET /whaletv/workbench/state payload. */
async function buildState() {
	const [branch, head, remote] = await Promise.all([
		git([
			"rev-parse",
			"--abbrev-ref",
			"HEAD"
		]),
		git([
			"rev-parse",
			"--short",
			"HEAD"
		]),
		git([
			"remote",
			"get-url",
			"origin"
		])
	]);
	return {
		ok: true,
		version: readVersion(),
		packageDir: PACKAGE_DIR,
		installKind: head !== void 0 ? "git" : "tarball",
		git: {
			configured: head !== void 0,
			...branch !== void 0 ? { branch } : {},
			...head !== void 0 ? { head } : {},
			...remote !== void 0 ? { remote } : {}
		},
		config: readConfig()
	};
}
/** Send one JSON response with a UTF-8 content type. */
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-cache"
	});
	res.end(payload);
}
/**
* Run the self-update pipeline and record the attempt into the rolling
* history (roadmap P1-9). Never throws: every failure returns an
* actionable { ok: false, error } result. History writes are best-effort —
* a broken updates.json must never turn a good update into a panel error.
*/
async function runUpdate(ctx, updateRepo) {
	const startedAt = /* @__PURE__ */ new Date();
	const result = await runUpdatePipeline(ctx, updateRepo);
	appendUpdateHistory({
		time: startedAt.toISOString(),
		ok: result.ok,
		...result.changed !== void 0 ? { changed: result.changed } : {},
		...result.rebuilt !== void 0 ? { rebuilt: result.rebuilt } : {},
		...result.needRestart !== void 0 ? { needRestart: result.needRestart } : {},
		...result.before !== void 0 ? { before: result.before } : {},
		...result.after !== void 0 ? { after: result.after } : {},
		...result.ok ? {} : { error: result.error }
	});
	return result;
}
/**
* The update pipeline proper (no history side effects): git checkouts run
* pull → install → bundle → hot-inject; tarball installs (no .git) hand the
* update to the dsh plugin-manager (roadmap v0.7.4).
*/
async function runUpdatePipeline(ctx, updateRepo) {
	const before = await git(["rev-parse", "HEAD"]);
	if (before === void 0) return runTarballUpdate(ctx, updateRepo);
	const remote = await git([
		"remote",
		"get-url",
		"origin"
	]);
	if (remote === void 0 || remote.trim() === "") return {
		ok: false,
		error: "未配置 git 远程仓库（origin）。请先执行 git remote add origin <仓库地址> 再重试。"
	};
	try {
		const pullOutput = await run("git", ["pull", "--ff-only"]);
		const after = await git(["rev-parse", "HEAD"]);
		const changed = after !== before;
		let installOutput = "";
		let bundleOutput = "";
		let rebuilt = false;
		if (changed) {
			installOutput = await run("pnpm", ["install", "--no-frozen-lockfile"]);
			installOutput += `\n${await run(process.execPath, ["scripts/link-harness-deps.mjs"])}`;
			bundleOutput = await run("pnpm", ["run", "bundle"]);
			ctx.clientModules.rebuilt(CLIENT_ID);
			rebuilt = true;
		}
		const output = [
			`$ git pull --ff-only\n${pullOutput}`,
			changed ? `\n$ pnpm install\n${installOutput}` : "",
			changed ? `\n$ pnpm run bundle\n${bundleOutput}` : ""
		].filter((part) => part !== "").join("\n");
		let serverChanged = true;
		if (changed && before !== void 0 && after !== void 0) {
			const touched = await git([
				"diff",
				"--name-only",
				before,
				after,
				"--",
				"src/index.ts",
				"tsdown.config.ts",
				"package.json"
			]);
			serverChanged = touched === void 0 || touched.trim() !== "";
		}
		return {
			ok: true,
			changed,
			rebuilt,
			...before !== void 0 ? { before } : {},
			...after !== void 0 ? { after } : {},
			output: truncate(output),
			needRestart: changed && serverChanged
		};
	} catch (error) {
		return {
			ok: false,
			error: truncate(String(error instanceof Error ? error.message : error))
		};
	}
}
/** Read `ctx.pluginManager` through the structural face; undefined when absent. */
function pluginManagerLike(ctx) {
	try {
		return ctx.pluginManager;
	} catch {
		return;
	}
}
/** Fetch the update repo's master package.json version (tarball update channel). */
async function fetchLatestTarballVersion(repo) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8e3);
	try {
		const response = await fetch(`https://raw.githubusercontent.com/${repo}/master/package.json`, { signal: controller.signal });
		if (!response.ok) return void 0;
		const version = (await response.json())?.version;
		return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : void 0;
	} catch {
		return;
	} finally {
		clearTimeout(timer);
	}
}
/** Whether `latest` is strictly newer than `installed` (x.y.z[, -prerelease] aware). */
function isSemverGt(latest, installed) {
	const parse = (value) => {
		const [core, pre = ""] = value.split("-");
		const [major = 0, minor = 0, patch = 0] = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
		return [
			major,
			minor,
			patch,
			pre
		];
	};
	const [lm, ln, lp, lpre] = parse(latest);
	const [im, inn, ip, ipre] = parse(installed);
	if (lm !== im) return lm > im;
	if (ln !== inn) return ln > inn;
	if (lp !== ip) return lp > ip;
	if (lpre !== ipre) return lpre !== "" && (ipre === "" || lpre > ipre);
	return false;
}
/**
* Tarball update (roadmap v0.7.4): hand the update to the host's own plugin
* manager — `installBundle('github:<repo>')` re-resolves the default branch's
* latest commit, installs through the same pnpm pipeline as `dsh plugin`,
* re-selects the bundle, and reports `restart-required` for an existing
* dependency. `approvedBuilds` keeps older scripted releases installable.
*/
async function runTarballUpdate(ctx, repo) {
	const manager = pluginManagerLike(ctx);
	if (manager?.installBundle === void 0) return {
		ok: false,
		tarball: true,
		error: "当前 dsh 未提供插件管理器服务，无法在线更新。请在桌面端的插件管理界面重装本插件以更新。"
	};
	const spec = `github:${repo}`;
	try {
		const change = await manager.installBundle(spec, { approvedBuilds: ["whaletv-workbench"] });
		if (change.application === "failed" || change.error !== void 0) return {
			ok: false,
			tarball: true,
			error: `插件管理器安装失败：${truncate(change.error?.diagnostic ?? change.packageResult?.output ?? `application: ${change.application}`)}`
		};
		const application = change.application === "restart-required" ? "重启 dsh 后新版本生效" : `application: ${change.application}`;
		return {
			ok: true,
			tarball: true,
			needRestart: true,
			changed: change.changed,
			output: truncate(`已通过 dsh 插件管理器安装 ${spec}。\napplication: ${change.application}\n${application}。`)
		};
	} catch (error) {
		return {
			ok: false,
			tarball: true,
			error: truncate(String(error instanceof Error ? error.message : error))
		};
	}
}
/**
* Update checker (roadmap P1-8): fetch the origin remote and compare HEAD
* against its upstream — ahead/behind counts plus the newest incoming commit
* subjects — without touching the working tree. `skippedHead` is the user's
* skip marker; when the remote head equals it the result is flagged so the
* panel can show "skipped" instead of nagging. Never throws.
*/
async function runUpdateCheck(skippedHead, updateRepo) {
	const branch = await git([
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	]);
	if (branch === void 0) {
		const installedVersion = readVersion();
		const latestVersion = await fetchLatestTarballVersion(updateRepo);
		if (latestVersion === void 0) return {
			ok: false,
			upToDate: false,
			tarball: true,
			installedVersion,
			error: "无法获取最新版本信息（访问 GitHub 失败）。请检查网络后重试。"
		};
		return {
			ok: true,
			upToDate: !isSemverGt(latestVersion, installedVersion),
			tarball: true,
			installedVersion,
			latestVersion
		};
	}
	let upstream = branch === "HEAD" ? void 0 : await git([
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{u}"
	]);
	if (upstream === void 0 || upstream.trim() === "") upstream = `origin/${branch}`;
	try {
		await run("git", [
			"fetch",
			"--quiet",
			upstream.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : "origin"
		]);
	} catch (error) {
		return {
			ok: false,
			upToDate: false,
			branch,
			upstream,
			error: truncate(`git fetch 失败：${String(error instanceof Error ? error.message : error)}`)
		};
	}
	const behindOut = await git([
		"rev-list",
		"--count",
		`HEAD..${upstream}`
	]);
	const aheadOut = await git([
		"rev-list",
		"--count",
		`${upstream}..HEAD`
	]);
	const behind = behindOut === void 0 ? void 0 : Number.parseInt(behindOut.trim(), 10);
	const ahead = aheadOut === void 0 ? void 0 : Number.parseInt(aheadOut.trim(), 10);
	if (behind === void 0 || Number.isNaN(behind) || ahead === void 0 || Number.isNaN(ahead)) return {
		ok: false,
		upToDate: false,
		branch,
		upstream,
		error: "无法比较本地与远端（git rev-list 失败）——请确认分支 upstream 有效。"
	};
	const commits = [];
	if (behind > 0) {
		const logOutput = await git([
			"log",
			"--oneline",
			"--no-decorate",
			`-${Math.min(behind, MAX_CHECK_COMMITS)}`,
			`HEAD..${upstream}`
		]);
		for (const line of (logOutput ?? "").split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			const split = trimmed.indexOf(" ");
			commits.push(split > 0 ? {
				sha: trimmed.slice(0, split),
				subject: trimmed.slice(split + 1)
			} : {
				sha: trimmed,
				subject: trimmed
			});
		}
	}
	const remoteHead = behind > 0 ? (await git([
		"rev-parse",
		"--short",
		upstream
	]))?.trim() : void 0;
	const marker = skippedHead.trim();
	return {
		ok: true,
		branch,
		upstream,
		upToDate: behind === 0,
		behind,
		ahead,
		...remoteHead !== void 0 && remoteHead !== "" ? { remoteHead } : {},
		...commits.length > 0 ? { commits } : {},
		...marker !== "" && remoteHead !== void 0 && remoteHead !== "" && remoteHead === marker ? { skipped: true } : {}
	};
}
/** Read the rolling update history; a missing/corrupt file is simply empty. */
function readUpdateHistory() {
	try {
		const parsed = JSON.parse(readFileSync(UPDATE_HISTORY_PATH, "utf8"));
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.entries)) return [];
		return parsed.entries.filter((entry) => {
			return entry !== null && typeof entry === "object" && typeof entry.time === "string" && typeof entry.ok === "boolean";
		});
	} catch {
		return [];
	}
}
/** Append one attempt to the rolling history (newest first), capped, atomic. */
function appendUpdateHistory(entry) {
	try {
		const entries = [entry, ...readUpdateHistory()].slice(0, MAX_HISTORY_ENTRIES);
		mkdirSync(WORKBENCH_STATE_DIR, { recursive: true });
		const tmp = `${UPDATE_HISTORY_PATH}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
		renameSync(tmp, UPDATE_HISTORY_PATH);
	} catch {}
}
/** Read the skill versioning records (roadmap P3-20); missing file is empty. */
function readInstalledRecords() {
	try {
		const parsed = JSON.parse(readFileSync(INSTALLED_RECORDS_PATH, "utf8"));
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.skills)) return [];
		return parsed.skills.filter((entry) => {
			const record = entry;
			return entry !== null && typeof entry === "object" && typeof record.name === "string" && record.name !== "" && typeof record.installedAt === "string";
		});
	} catch {
		return [];
	}
}
/** Merge new/updated records by name and persist atomically (roadmap P3-20). */
function upsertInstalledRecords(incoming) {
	if (incoming.length === 0) return;
	const byName = new Map(readInstalledRecords().map((record) => [record.name, record]));
	for (const record of incoming) byName.set(record.name, record);
	const merged = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	try {
		mkdirSync(WORKBENCH_STATE_DIR, { recursive: true });
		const tmp = `${INSTALLED_RECORDS_PATH}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ skills: merged }, null, 2)}\n`, "utf8");
		renameSync(tmp, INSTALLED_RECORDS_PATH);
	} catch {}
}
/** Drop records whose names are gone (post-remove), atomic, best-effort. */
function pruneInstalledRecords(names) {
	if (names.length === 0) return;
	const drop = new Set(names);
	const remaining = readInstalledRecords().filter((record) => !drop.has(record.name));
	try {
		mkdirSync(WORKBENCH_STATE_DIR, { recursive: true });
		const tmp = `${INSTALLED_RECORDS_PATH}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ skills: remaining }, null, 2)}\n`, "utf8");
		renameSync(tmp, INSTALLED_RECORDS_PATH);
	} catch {}
}
/**
* Roll the working tree back to the state before the last successful update
* (roadmap P1-9): reset --hard to that entry's `before` SHA, rebuild the
* bundle, and hot-inject. Refuses a dirty worktree — a reset would destroy
* local edits. Never throws.
*/
async function runUpdateRollback(ctx) {
	const lastOk = readUpdateHistory().find((entry) => entry.ok === true && entry.changed === true && typeof entry.before === "string");
	if (lastOk === void 0) return {
		ok: false,
		error: "没有可回滚的成功更新记录（updates.json 为空或全部失败）。"
	};
	const dirty = await git(["status", "--porcelain"]);
	if (dirty !== void 0 && dirty.trim() !== "") return {
		ok: false,
		error: "工作区有未提交的本地修改，回滚会丢弃它们；请先 commit / stash 再试。"
	};
	const target = lastOk.before;
	try {
		const resetOutput = await run("git", [
			"reset",
			"--hard",
			target
		]);
		const bundleOutput = await run("pnpm", ["run", "bundle"]);
		ctx.clientModules.rebuilt(CLIENT_ID);
		appendUpdateHistory({
			time: (/* @__PURE__ */ new Date()).toISOString(),
			ok: true,
			changed: true,
			rebuilt: true,
			needRestart: true,
			after: target
		});
		return {
			ok: true,
			revertedTo: target,
			output: truncate(`$ git reset --hard ${target}\n${resetOutput}\n$ pnpm run bundle\n${bundleOutput}`),
			needRestart: true
		};
	} catch (error) {
		const message = truncate(String(error instanceof Error ? error.message : error));
		appendUpdateHistory({
			time: (/* @__PURE__ */ new Date()).toISOString(),
			ok: false,
			error: `rollback: ${message}`
		});
		return {
			ok: false,
			error: message
		};
	}
}
/** Read the skipped-head marker (roadmap P1-10); missing file is empty. */
function readSkippedHead() {
	try {
		const marker = JSON.parse(readFileSync(UPDATE_STATE_PATH, "utf8"))?.skippedHead;
		return typeof marker === "string" ? marker : "";
	} catch {
		return "";
	}
}
/** Persist the skipped-head marker atomically; best-effort. */
function writeSkippedHead(sha) {
	try {
		mkdirSync(WORKBENCH_STATE_DIR, { recursive: true });
		const tmp = `${UPDATE_STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ skippedHead: sha }, null, 2)}\n`, "utf8");
		renameSync(tmp, UPDATE_STATE_PATH);
	} catch {}
}
/**
* Clear the skip marker after a successful update moved to a new head — the
* reminder re-arms for whatever comes next. Best-effort; never throws.
*/
function clearSkippedHead() {
	writeSkippedHead("");
}
/** Read the usage ledger; a missing/corrupt file is simply empty. */
function readUsage() {
	try {
		const parsed = JSON.parse(readFileSync(USAGE_PATH, "utf8"));
		if (parsed === null || typeof parsed !== "object") return {};
		const usage = {};
		for (const [id, value] of Object.entries(parsed)) {
			const record = value;
			if (typeof record?.count === "number" && typeof record?.lastUsed === "string") usage[id] = {
				count: record.count,
				lastUsed: record.lastUsed
			};
		}
		return usage;
	} catch {
		return {};
	}
}
/** Increment one item's launch counter, pruning the ledger to the most recent ids. */
function recordUsage(itemId) {
	if (itemId === "" || itemId.length > 128) return;
	try {
		const usage = readUsage();
		usage[itemId] = {
			count: (usage[itemId]?.count ?? 0) + 1,
			lastUsed: (/* @__PURE__ */ new Date()).toISOString()
		};
		const capped = Object.entries(usage).sort(([, a], [, b]) => a.lastUsed < b.lastUsed ? 1 : -1).slice(0, MAX_USAGE_ENTRIES);
		mkdirSync(WORKBENCH_STATE_DIR, { recursive: true });
		const tmp = `${USAGE_PATH}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(capped), null, 2)}\n`, "utf8");
		renameSync(tmp, USAGE_PATH);
	} catch {}
}
/**
* One entry's reachability probe (roadmap P2-16): HEAD with a GET fallback
* for sites that reject HEAD (403/405), path existence for local targets.
*/
async function checkEntryHealth(item) {
	if (item.url !== void 0 && item.url !== "") {
		const probe = async (method) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
			try {
				const response = await fetch(item.url, {
					method,
					redirect: "follow",
					signal: controller.signal
				});
				return {
					ok: response.status < 400,
					detail: `HTTP ${response.status}`
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					detail: message === "This operation was aborted" ? `超时（>${HEALTH_TIMEOUT_MS / 1e3}s）` : message
				};
			} finally {
				clearTimeout(timer);
			}
		};
		const head = await probe("HEAD");
		if (head.ok || head.detail === "HTTP 404") return head;
		return probe("GET");
	}
	if (item.path !== void 0 && item.path !== "") return existsSync(item.path) ? {
		ok: true,
		detail: "路径存在"
	} : {
		ok: false,
		detail: "路径不存在"
	};
	return {
		ok: false,
		detail: "未配置目标"
	};
}
/** Probe every entry in the config (roadmap P2-16), keyed by item id. */
async function runHealthCheck(config) {
	const results = {};
	for (const group of config.groups) for (const item of group.items) results[item.id] = await checkEntryHealth(item);
	return results;
}
/**
* Whether a favicon origin may be fetched: http(s) only, non-private host.
* @returns an error reason, or undefined when allowed.
*/
function faviconOriginError(origin) {
	let parsed;
	try {
		parsed = new URL(origin);
	} catch {
		return "URL 无法解析";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "仅支持 http(s)";
	if (parsed.pathname !== "/" && parsed.pathname !== "") return "只接受 origin（协议+主机），忽略路径";
	if (PRIVATE_HOST_PATTERN.test(parsed.hostname)) return "拒绝内网 / 环回地址";
}
/** Per-origin cache filename for the favicon proxy. */
function faviconFile(origin) {
	const hash = createHash("sha1").update(origin).digest("hex").slice(0, 16);
	return join(ICON_DIR, `${hash}.ico`);
}
const FAVICON_MIME_BY_EXT = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon"
};
/**
* Serve a cached favicon for the given origin (roadmap P2-17), downloading
* `<origin>/favicon.ico` on first use. Cache-forever per origin (the file is
* content-addressed by origin); 404 when uncached and unfetchable — the
* panel hides the img on error.
*/
async function serveFavicon(url) {
	const originError = faviconOriginError(url);
	if (originError !== void 0) return {
		status: 400,
		contentType: "text/plain; charset=utf-8",
		body: Buffer.from(originError),
		cache: "no-store"
	};
	mkdirSync(ICON_DIR, { recursive: true });
	const cached = faviconFile(url);
	if (existsSync(cached)) {
		const ext = cached.slice(cached.lastIndexOf("."));
		return {
			status: 200,
			contentType: FAVICON_MIME_BY_EXT[ext] ?? "application/octet-stream",
			body: readFileSync(cached),
			cache: "public, max-age=604800"
		};
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
	try {
		const response = await fetch(new URL("/favicon.ico", url), {
			signal: controller.signal,
			redirect: "follow"
		});
		if (!response.ok) return {
			status: 404,
			contentType: "text/plain; charset=utf-8",
			body: Buffer.from("favicon 不可用"),
			cache: "no-store"
		};
		const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
		const ext = Object.entries(FAVICON_MIME_BY_EXT).find(([, mime]) => mime === contentType)?.[0] ?? ".ico";
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.length === 0 || buffer.length > ICON_MAX_BYTES) return {
			status: 404,
			contentType: "text/plain; charset=utf-8",
			body: Buffer.from("favicon 尺寸异常"),
			cache: "no-store"
		};
		const target = cached.slice(0, cached.lastIndexOf(".")) + ext;
		writeFileSync(target, buffer);
		return {
			status: 200,
			contentType: contentType !== "" ? contentType : "image/x-icon",
			body: buffer,
			cache: "public, max-age=604800"
		};
	} catch (error) {
		return {
			status: 404,
			contentType: "text/plain; charset=utf-8",
			body: Buffer.from(`favicon 抓取失败：${error instanceof Error ? error.message : String(error)}`),
			cache: "no-store"
		};
	} finally {
		clearTimeout(timer);
	}
}
/**
* Return the on-disk absolute path of a workbench-managed skill (directory
* bundle preferred; flat markdown accepted for compatibility with the
* dsh-skill-filesystem provider).
*/
function findManagedSkillPath(name) {
	const bundleDir = join(USER_DSH_SKILLS_DIR, name);
	const bundleSkill = join(bundleDir, "SKILL.md");
	if (existsSync(bundleSkill)) return bundleSkill;
	const flat = join(USER_DSH_SKILLS_DIR, `${name}.md`);
	if (existsSync(flat)) return flat;
}
/**
* Diagnostic payload for the "file on disk but not visible" case. Surfaces
* both what our Host thinks is the user-dsh root and what dsh's own skill
* registry returns from a live `snapshot()`, alongside relevant env vars.
* When they diverge, the mismatch shape (path differs, catalog empty, or
* both) tells us which layer to fix.
*/
async function buildSkillDebug(ctx) {
	let userDshSkillsContents = [];
	let readError;
	try {
		if (existsSync(USER_DSH_SKILLS_DIR)) userDshSkillsContents = readdirSync(USER_DSH_SKILLS_DIR);
	} catch (error) {
		readError = error instanceof Error ? error.message : String(error);
	}
	let snapshot;
	let snapshotError;
	try {
		snapshot = await ctx.skills.snapshot({});
	} catch (error) {
		snapshotError = error instanceof Error ? error.message : String(error);
	}
	return {
		ok: true,
		workbenchView: {
			dshHome: DSH_HOME,
			userDshSkillsDir: USER_DSH_SKILLS_DIR,
			userDshSkillsExists: existsSync(USER_DSH_SKILLS_DIR),
			userDshSkillsContents,
			...readError !== void 0 ? { readError } : {}
		},
		env: {
			DSH_HOME: process.env.DSH_HOME ?? null,
			DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? null,
			DSH_BUNDLED_SKILL_DIR: process.env.DSH_BUNDLED_SKILL_DIR ?? null,
			USERPROFILE: process.env.USERPROFILE ?? null,
			HOME: process.env.HOME ?? null,
			cwd: process.cwd()
		},
		dshRegistry: {
			snapshot,
			...snapshotError !== void 0 ? { snapshotError } : {}
		}
	};
}
/**
* Assemble the GET /whaletv/workbench/skills payload from ctx.skills'
* catalog. `removable` is true only for skills whose files live inside
* $DSH_HOME/skills — those the install route wrote or the user placed by
* hand under our root. Skills from project/agent/bundled sources are read-only.
*/
async function buildSkillList(ctx, records) {
	try {
		const snap = await ctx.skills.snapshot({});
		const recordByName = new Map(records.map((record) => [record.name, record]));
		return {
			ok: true,
			skills: snap.skills.map((s) => ({
				name: s.name,
				description: s.description,
				...s.whenToUse !== void 0 ? { whenToUse: s.whenToUse } : {},
				source: s.source,
				provider: s.provider,
				removable: recordByName.has(s.name) || findManagedSkillPath(s.name) !== void 0,
				...recordByName.has(s.name) ? { origin: recordByName.get(s.name) } : {}
			})),
			complete: snap.complete
		};
	} catch (error) {
		return {
			ok: false,
			skills: [],
			complete: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
/**
* Write a skill definition into `$DSH_HOME/skills/<name>/SKILL.md` and add
* its name to the installed-skills registry. Chokidar inside
* dsh-skill-filesystem watches this root, so the model-facing catalog picks
* the new skill up on its next `agent/pre-step`.
*/
function installSkillOnDisk(name, content) {
	if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`skill 名称必须为 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$），收到：${name}`);
	const bundleDir = join(USER_DSH_SKILLS_DIR, name);
	mkdirSync(bundleDir, { recursive: true });
	const target = join(bundleDir, "SKILL.md");
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, target);
	return target;
}
/**
* Shallow-clone a git repo and copy the skill body inside it into
* `$DSH_HOME/skills/<name>/`. Supports both bundle form
* (`<subPath>/SKILL.md` + adjacent resource files copied wholesale) and flat
* form (`<subPath>.md` copied to `<name>.md`).
*
* Safety:
*   - URL is restricted to http(s) / ssh — no `file://` or local paths.
*   - `--` before the URL and dest prevents git from interpreting them as flags.
*   - Ref is checked against `GIT_REF_PATTERN` — no `--upload-pack=` injection.
*   - Resolved source path is verified to stay inside the staging tree so a
*     malicious sub-path can't escape via `../..`.
*   - Staging clone is removed on both success and failure.
*
* @returns installed names, per-skill source sub-paths (versioning records,
*   roadmap P3-20), source head SHA, and captured git output
*/
async function importSkillFromGit(request) {
	const targetName = request.name?.trim() ?? "";
	const url = request.url?.trim() ?? "";
	const subPath = request.subPath?.trim() ?? "";
	const ref = request.ref?.trim() ?? "";
	if (!SKILL_NAME_PATTERN.test(targetName)) throw new Error(`目标名称必须为 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$），收到：${targetName || "<空>"}`);
	if (/^skill(?:\.md)?$/i.test(targetName)) throw new Error("名称 \"skill\" 冲突（SKILL.md 是 dsh 的 bundle 保留文件名）；请显式指定一个具体名称，例如 \"whaletv-dev-power\" / \"agent-engineering-framework\"。");
	if (!GIT_URL_PATTERN.test(url)) throw new Error(`仅支持 http/https/ssh 协议的 git 仓库地址；收到：${url || "<空>"}`);
	if (ref !== "" && !GIT_REF_PATTERN.test(ref)) throw new Error(`ref/branch 只能包含字母数字与 . _ - / ；收到：${ref}`);
	if (subPath.includes("..")) throw new Error("子路径不能包含 `..`（防止越权到仓库外）");
	mkdirSync(IMPORT_STAGING_DIR, { recursive: true });
	const staging = mkdtempSync(join(IMPORT_STAGING_DIR, "skill-"));
	try {
		const args = [
			"clone",
			"--depth",
			"1",
			"--no-tags",
			"--single-branch"
		];
		if (ref !== "") args.push("--branch", ref);
		args.push("--", url, staging);
		let gitOutput;
		try {
			gitOutput = await run("git", args, IMPORT_STAGING_DIR);
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			try {
				removeStagingSafely(staging);
			} catch {}
			throw new Error(translateGitError(url, raw));
		}
		const source = subPath === "" ? staging : join(staging, subPath);
		if (!source.startsWith(staging)) throw new Error(`子路径解析出的目录越权：${source}`);
		if (!existsSync(source)) throw new Error(`仓库里未找到子路径：${subPath === "" ? "<repo 根目录>" : subPath}`);
		let sha;
		try {
			sha = (await run("git", [
				"rev-parse",
				"--short",
				"HEAD"
			], staging)).trim();
		} catch {}
		const sourcesFor = (names) => names.map((name) => ({
			name,
			subPath: subPath === "" ? "" : `${subPath.replace(/\/+$/, "")}/${name}`
		}));
		mkdirSync(USER_DSH_SKILLS_DIR, { recursive: true });
		const resolved = resolveSkillSource(source, statSync(source));
		if (resolved.kind === "bundle") {
			const dest = join(USER_DSH_SKILLS_DIR, targetName);
			installBundleDir(resolved.dir, dest, staging);
			return {
				installed: [targetName],
				writtenTo: join(dest, "SKILL.md"),
				...sha !== void 0 ? { sha } : {},
				sources: [{
					name: targetName,
					subPath
				}],
				output: gitOutput
			};
		}
		if (resolved.kind === "flat") {
			const dest = join(USER_DSH_SKILLS_DIR, `${targetName}.md`);
			if (existsSync(dest)) rmSync(dest, { force: true });
			cpSync(resolved.file, dest);
			return {
				installed: [targetName],
				writtenTo: dest,
				...sha !== void 0 ? { sha } : {},
				sources: [{
					name: targetName,
					subPath
				}],
				output: gitOutput
			};
		}
		if (resolved.kind === "batch") {
			const installed = [];
			const skipped = [];
			for (const child of resolved.children) {
				if (!SKILL_NAME_PATTERN.test(child)) {
					skipped.push({
						name: child,
						reason: "目录名不是 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$）"
					});
					continue;
				}
				if (/^skill(?:\.md)?$/i.test(child)) {
					skipped.push({
						name: child,
						reason: "目录名与保留字冲突（SKILL.md 的 bundle 保留字）"
					});
					continue;
				}
				const srcDir = join(resolved.root, child);
				const dest = join(USER_DSH_SKILLS_DIR, child);
				try {
					installBundleDir(srcDir, dest, staging);
					installed.push(child);
				} catch (error) {
					skipped.push({
						name: child,
						reason: error instanceof Error ? error.message : String(error)
					});
				}
			}
			if (installed.length === 0) throw new Error(`在 ${subPath === "" ? "<repo 根目录>" : subPath} 找到 ${resolved.children.length} 个候选，但没有一个可以安装：\n` + skipped.map((s) => ` - ${s.name}：${s.reason}`).join("\n"));
			return {
				installed,
				skipped: skipped.length > 0 ? skipped : void 0,
				writtenTo: USER_DSH_SKILLS_DIR,
				...sha !== void 0 ? { sha } : {},
				sources: sourcesFor(installed),
				output: gitOutput
			};
		}
		throw new Error(`在 ${subPath === "" ? "<repo 根目录>" : subPath} 未找到 SKILL.md 或 <name>.md，也没有子目录级别的 skill bundle`);
	} finally {
		try {
			removeStagingSafely(staging);
		} catch {}
	}
}
/**
* Windows-friendly recursive delete: retry with a short delay so Node's
* fs.rmSync can win the race against git.exe / antivirus still holding
* handles on freshly-written `.git/pack/*` files right after clone.
*
* `maxRetries` + `retryDelay` are documented options on Node ≥ 14.14 and
* are exactly designed for this scenario. `force: true` also overrides
* the read-only bit git sets on pack files.
*/
function removeStagingSafely(path) {
	rmSync(path, {
		recursive: true,
		force: true,
		maxRetries: 8,
		retryDelay: 250
	});
}
/**
* Sweep any stale `skill-*` directories left behind by past failed clones
* (Windows file-lock timing, dsh crashed mid-import, etc.). Runs once on
* plugin mount as a best-effort — a single retry cycle here is enough
* because whatever process was holding handles is long gone by now.
*/
function sweepStagingDir() {
	if (!existsSync(IMPORT_STAGING_DIR)) return;
	try {
		for (const entry of readdirSync(IMPORT_STAGING_DIR)) {
			if (!entry.startsWith("skill-")) continue;
			try {
				removeStagingSafely(join(IMPORT_STAGING_DIR, entry));
			} catch {}
		}
	} catch {}
}
/**
* Copy one bundle directory into $DSH_HOME/skills/<name>/, dropping any
* `.git` remains from the shallow clone. `staging` is only used to help
* the filter recognize the git dir path prefix — everything is otherwise
* relative to `srcDir`.
*/
function installBundleDir(srcDir, dest, staging) {
	if (existsSync(dest)) rmSync(dest, {
		recursive: true,
		force: true,
		maxRetries: 8,
		retryDelay: 250
	});
	cpSync(srcDir, dest, {
		recursive: true,
		filter: (src) => !src.startsWith(join(staging, ".git")) && basename(src) !== ".git"
	});
	const gitDir = join(dest, ".git");
	if (existsSync(gitDir)) rmSync(gitDir, {
		recursive: true,
		force: true,
		maxRetries: 8,
		retryDelay: 250
	});
}
/**
* Classify the cloned tree at `source` (may be a file or a directory).
*
* When source is a file:
*   - `.../SKILL.md` → bundle (walk up one level to the enclosing dir)
*   - `.../*.md` (any other markdown) → flat
*   - otherwise → none
*
* When source is a directory:
*   - `<source>/SKILL.md` exists → single bundle
*   - one or more `<source>/<child>/SKILL.md` exists → batch (list children)
*   - otherwise → none
*/
function resolveSkillSource(source, stat) {
	if (stat.isFile()) {
		if (/^SKILL\.md$/i.test(basename(source))) return {
			kind: "bundle",
			dir: dirname(source)
		};
		if (source.toLowerCase().endsWith(".md")) return {
			kind: "flat",
			file: source
		};
		return { kind: "none" };
	}
	if (!stat.isDirectory()) return { kind: "none" };
	if (existsSync(join(source, "SKILL.md"))) return {
		kind: "bundle",
		dir: source
	};
	try {
		const children = readdirSync(source).filter((entry) => {
			if (entry.startsWith(".")) return false;
			const childDir = join(source, entry);
			let childStat;
			try {
				childStat = statSync(childDir);
			} catch {
				return false;
			}
			if (!childStat.isDirectory()) return false;
			return existsSync(join(childDir, "SKILL.md"));
		});
		if (children.length > 0) return {
			kind: "batch",
			root: source,
			children
		};
	} catch {}
	return { kind: "none" };
}
/**
* Rank at which our workbench-owned provider announces its skills.
*
* dsh-skill-filesystem's `user-dsh` root sits at rank 400; we register at
* 450 so when both providers work the built-in wins duplicate names by
* rank. When dsh's provider isn't functioning (missing config, schema
* quirk, chokidar didn't fire on Windows), ours still surfaces the file
* — which is the reason this provider exists at all.
*/
const WORKBENCH_PROVIDER_RANK = 450;
const WORKBENCH_PROVIDER_NAME = "whaletv-workbench-user-dsh";
/**
* Parse the leading YAML frontmatter block of a SKILL.md. Returns empty
* front + full body when the file lacks frontmatter, so downstream logic
* can still surface the skill under its directory / filename identity.
*/
function parseFrontmatter(raw) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (match === null) return {
		front: {},
		body: raw
	};
	try {
		const parsed = parse(match[1] ?? "");
		const front = {};
		if (parsed !== null && typeof parsed === "object") {
			if (typeof parsed.name === "string") front.name = parsed.name;
			if (typeof parsed.description === "string") front.description = parsed.description;
			const whenToUse = parsed["when-to-use"] ?? parsed.whenToUse;
			if (typeof whenToUse === "string") front.whenToUse = whenToUse;
			if (typeof parsed["disable-model-invocation"] === "boolean") front.disableModelInvocation = parsed["disable-model-invocation"];
			if (typeof parsed["user-invocable"] === "boolean") front.userInvocable = parsed["user-invocable"];
		}
		return {
			front,
			body: match[2] ?? ""
		};
	} catch {
		return {
			front: {},
			body: raw
		};
	}
}
function discoverWorkbenchSkills() {
	if (!existsSync(USER_DSH_SKILLS_DIR)) return [];
	const results = [];
	let entries;
	try {
		entries = readdirSync(USER_DSH_SKILLS_DIR);
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const abs = join(USER_DSH_SKILLS_DIR, entry);
		let stats;
		try {
			stats = statSync(abs);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			const skillMd = join(abs, "SKILL.md");
			if (existsSync(skillMd) && SKILL_NAME_PATTERN.test(entry)) results.push({
				name: entry,
				path: skillMd,
				resourcePath: abs
			});
		} else if (stats.isFile() && entry.toLowerCase().endsWith(".md")) {
			const name = entry.slice(0, -3);
			if (SKILL_NAME_PATTERN.test(name)) results.push({
				name,
				path: abs
			});
		}
	}
	return results;
}
/**
* Register a workbench-owned skill provider scanning `$DSH_HOME/skills`.
* Held in a closure so the write routes can `invalidate()` after modifying
* the folder — dsh-skill-filesystem's chokidar can miss fresh writes on
* Windows, so an explicit invalidation makes catalog updates deterministic.
*
* @returns the invalidator, callable by handlers after a disk mutation.
*/
function registerWorkbenchSkillProvider(ctx) {
	const ref = { invalidate: () => {} };
	ctx.skills.registerProvider((control) => {
		ref.invalidate = control.invalidate;
		return {
			name: WORKBENCH_PROVIDER_NAME,
			list: async (_options) => {
				return discoverWorkbenchSkills().map((entry) => {
					let front = {};
					try {
						front = parseFrontmatter(readFileSync(entry.path, "utf8")).front;
					} catch {}
					return {
						name: entry.name,
						description: front.description ?? "",
						...front.whenToUse !== void 0 ? { whenToUse: front.whenToUse } : {},
						invocation: {
							modelInvocable: !(front.disableModelInvocation ?? false),
							userInvocable: front.userInvocable ?? true
						},
						source: "user-dsh",
						provider: WORKBENCH_PROVIDER_NAME,
						rank: WORKBENCH_PROVIDER_RANK,
						locator: entry.path,
						path: entry.path,
						...entry.resourcePath !== void 0 ? { resourceBase: {
							kind: "directory",
							path: entry.resourcePath
						} } : {}
					};
				});
			},
			get: async (candidate, _options) => {
				const path = typeof candidate.locator === "string" ? candidate.locator : void 0;
				if (path === void 0 || !existsSync(path)) return void 0;
				try {
					const { body } = parseFrontmatter(readFileSync(path, "utf8"));
					return {
						...candidate,
						content: body,
						path
					};
				} catch {
					return;
				}
			}
		};
	});
	return ref;
}
/**
* Remove a workbench-installed skill directory. Refuses to touch anything
* outside `$DSH_HOME/skills` — the only place install writes to.
*/
function removeSkillOnDisk(name) {
	if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`skill 名称必须为 kebab-case，收到：${name}`);
	const bundleDir = join(USER_DSH_SKILLS_DIR, name);
	const flat = join(USER_DSH_SKILLS_DIR, `${name}.md`);
	if (existsSync(bundleDir) && statSync(bundleDir).isDirectory()) {
		rmSync(bundleDir, {
			recursive: true,
			force: true
		});
		return;
	}
	if (existsSync(flat)) {
		rmSync(flat, { force: true });
		return;
	}
	throw new Error(`未找到 skill：${name}（工作台只能删除自己写入 $DSH_HOME/skills 的 skill）`);
}
/**
* Route a follow-up prompt into an existing live agent's inbox.
*
* Prefers the client-supplied sessionId; falls back to
* `ctx.agents.currentInitiator()` which is only meaningful when the caller
* itself already runs inside an agent-scoped async chain — usually not the
* case for an HTTP handler, so browsers should pass sessionId whenever the
* visible session id is known.
*/
function submitFollowup(ctx, request) {
	const prompt = request.prompt.trim();
	if (prompt === "") return {
		ok: false,
		error: "提示词不能为空"
	};
	const agent = request.sessionId !== void 0 && request.sessionId !== "" ? ctx.agents.get(request.sessionId) : ctx.agents.currentInitiator();
	if (agent === void 0) return {
		ok: false,
		error: request.sessionId === void 0 ? "未提供 sessionId 且当前请求无 initiator——请从前端传入当前会话 id" : `未找到会话：${request.sessionId}`
	};
	agent.followup(createUserMessage({
		content: [{
			type: "text",
			text: prompt
		}],
		source: { kind: "user" }
	}));
	return {
		ok: true,
		sessionId: agent.id
	};
}
/**
* Extract the sub-path a request landed on within the workbench route
* prefix. Strips the shared prefix and any query string.
*/
function subPath(req) {
	const noQuery = (req.url ?? "").split("?", 1)[0] ?? "";
	return noQuery.startsWith(ROUTE_PREFIX) ? noQuery.slice(18) : "";
}
/**
* Register the workbench routes and the settings namespace.
*
* One `kind: 'prefix'` seat covers every sub-path under
* `/whaletv/workbench/*` and dispatches internally; a closure-scoped
* `updating` flag prevents concurrent update runs and never leaks across
* plugin hot-reloads. The settings namespace joins the plugin's Host state
* to the browser card by name.
*
* @param ctx - host context populated with the injected services.
* @param config - schemastery-resolved config (composition entry + user layer + defaults).
*/
function apply(ctx, config) {
	sweepStagingDir();
	const settingsForms = ctx.settings;
	try {
		settingsForms?.configure?.({ auto: false });
	} catch {}
	const skillProvider = registerWorkbenchSkillProvider(ctx);
	let updating = false;
	ctx.effect(() => {
		const disposeRoutes = ctx.webServer.register({
			kind: "prefix",
			path: ROUTE_PREFIX,
			handler: (req, res) => {
				const sub = subPath(req);
				const method = req.method;
				if (sub === "/state" && (method === void 0 || method === "GET" || method === "HEAD")) {
					buildState().then((state) => {
						sendJson(res, 200, state);
					}, (error) => {
						sendJson(res, 500, {
							ok: false,
							error: String(error)
						});
					});
					return;
				}
				if (sub === "/config") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					readJsonBody(req, MAX_CONFIG_BYTES).then((raw) => {
						try {
							writeConfig(sanitizeConfig(raw));
							sendJson(res, 200, { ok: true });
						} catch (error) {
							sendJson(res, 400, {
								ok: false,
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}, (error) => {
						sendJson(res, 400, {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
					});
					return;
				}
				if (sub === "/update") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					if (updating) {
						sendJson(res, 409, {
							ok: false,
							error: "已有更新正在进行中，请稍候。"
						});
						return;
					}
					updating = true;
					runUpdate(ctx, config.updateRepo).then((result) => {
						if (result.ok && result.changed === true) clearSkippedHead();
						sendJson(res, result.ok ? 200 : 500, result);
					}, (error) => {
						sendJson(res, 500, {
							ok: false,
							error: String(error)
						});
					}).finally(() => {
						updating = false;
					});
					return;
				}
				if (sub === "/update/check" && (method === void 0 || method === "GET" || method === "HEAD")) {
					runUpdateCheck(readSkippedHead(), config.updateRepo).then((result) => {
						sendJson(res, result.ok ? 200 : 500, result);
					}, (error) => {
						sendJson(res, 500, {
							ok: false,
							upToDate: false,
							error: String(error)
						});
					});
					return;
				}
				if (sub === "/update/history" && (method === void 0 || method === "GET" || method === "HEAD")) {
					sendJson(res, 200, {
						ok: true,
						entries: readUpdateHistory()
					});
					return;
				}
				if (sub === "/update/skip") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					readJsonBody(req, 4096).then(async (raw) => {
						try {
							const request = raw;
							const sha = typeof request.sha === "string" ? request.sha.trim() : "";
							if (!SHA_PATTERN.test(sha)) throw new Error(`sha 必须是 7-40 位十六进制，收到：${sha || "<空>"}`);
							writeSkippedHead(sha.toLowerCase());
							sendJson(res, 200, {
								ok: true,
								skippedHead: sha.toLowerCase()
							});
						} catch (error) {
							sendJson(res, 400, {
								ok: false,
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}, (error) => {
						sendJson(res, 400, {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
					});
					return;
				}
				if (sub === "/update/rollback") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					if (updating) {
						sendJson(res, 409, {
							ok: false,
							error: "已有更新或回滚正在进行中，请稍候。"
						});
						return;
					}
					updating = true;
					runUpdateRollback(ctx).then((result) => {
						sendJson(res, result.ok ? 200 : 500, result);
					}, (error) => {
						sendJson(res, 500, {
							ok: false,
							error: String(error)
						});
					}).finally(() => {
						updating = false;
					});
					return;
				}
				if (sub === "/usage" && (method === void 0 || method === "GET" || method === "HEAD")) {
					sendJson(res, 200, {
						ok: true,
						usage: readUsage()
					});
					return;
				}
				if (sub === "/usage/record") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					readJsonBody(req, 4096).then((raw) => {
						try {
							const itemId = typeof raw.itemId === "string" ? raw.itemId.trim() : "";
							if (itemId === "") throw new Error("itemId 不能为空");
							recordUsage(itemId);
							sendJson(res, 200, { ok: true });
						} catch (error) {
							sendJson(res, 400, {
								ok: false,
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}, (error) => {
						sendJson(res, 400, {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
					});
					return;
				}
				if (sub === "/health" && (method === void 0 || method === "GET" || method === "HEAD")) {
					runHealthCheck(readConfig()).then((results) => {
						sendJson(res, 200, {
							ok: true,
							results
						});
					}, (error) => {
						sendJson(res, 500, {
							ok: false,
							error: String(error)
						});
					});
					return;
				}
				if (sub === "/icon" && (method === void 0 || method === "GET" || method === "HEAD")) {
					serveFavicon(new URL(req.url ?? "/", "http://localhost").searchParams.get("url") ?? "").then((icon) => {
						res.writeHead(icon.status, {
							"Content-Type": icon.contentType,
							"Content-Length": icon.body.length,
							"Cache-Control": icon.cache
						});
						res.end(method === "HEAD" ? void 0 : icon.body);
					}, (error) => {
						sendJson(res, 500, {
							ok: false,
							error: String(error)
						});
					});
					return;
				}
				if (sub === "/skills" && (method === void 0 || method === "GET" || method === "HEAD")) {
					buildSkillList(ctx, readInstalledRecords()).then((payload) => {
						sendJson(res, payload.ok ? 200 : 500, payload);
					}, (error) => {
						sendJson(res, 500, {
							ok: false,
							skills: [],
							complete: false,
							error: String(error)
						});
					});
					return;
				}
				if (sub === "/skills/debug" && (method === void 0 || method === "GET" || method === "HEAD")) {
					buildSkillDebug(ctx).then((payload) => {
						sendJson(res, 200, payload);
					}, (error) => {
						sendJson(res, 500, {
							ok: false,
							error: String(error)
						});
					});
					return;
				}
				if (sub === "/skills/install") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					readJsonBody(req, MAX_SKILL_BYTES).then(async (raw) => {
						try {
							const request = raw;
							const skillName = cleanString(request.name);
							const content = typeof request.content === "string" ? request.content : "";
							if (skillName === void 0) throw new Error("skill 名称不能为空");
							if (content.trim() === "") throw new Error("skill 内容不能为空");
							const writtenTo = installSkillOnDisk(skillName, content);
							upsertInstalledRecords([{
								...readInstalledRecords().find((entry) => entry.name === skillName) ?? { name: skillName },
								installedAt: (/* @__PURE__ */ new Date()).toISOString()
							}]);
							skillProvider.invalidate();
							sendJson(res, 200, {
								ok: true,
								writtenTo
							});
						} catch (error) {
							sendJson(res, 400, {
								ok: false,
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}, (error) => {
						sendJson(res, 400, {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
					});
					return;
				}
				if (sub === "/skills/import") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					readJsonBody(req, MAX_SKILL_BYTES).then(async (raw) => {
						try {
							const request = raw;
							if (typeof request.url !== "string") throw new Error("url 必须是字符串");
							if (typeof request.name !== "string") throw new Error("name 必须是字符串");
							const outcome = await importSkillFromGit(request);
							skillProvider.invalidate();
							const installedAt = (/* @__PURE__ */ new Date()).toISOString();
							const sourceByName = new Map((outcome.sources ?? []).map((entry) => [entry.name, entry.subPath]));
							upsertInstalledRecords(outcome.installed.map((name) => ({
								name,
								sourceUrl: request.url,
								...outcome.sha !== void 0 ? { sha: outcome.sha } : {},
								...sourceByName.get(name) !== void 0 && sourceByName.get(name) !== "" ? { subPath: sourceByName.get(name) } : {},
								...typeof request.ref === "string" && request.ref.trim() !== "" ? { ref: request.ref.trim() } : {},
								installedAt
							})));
							sendJson(res, 200, {
								ok: true,
								installed: outcome.installed,
								...outcome.skipped !== void 0 ? { skipped: outcome.skipped } : {},
								...outcome.writtenTo !== void 0 ? { writtenTo: outcome.writtenTo } : {},
								output: truncate(outcome.output)
							});
						} catch (error) {
							sendJson(res, 400, {
								ok: false,
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}, (error) => {
						sendJson(res, 400, {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
					});
					return;
				}
				if (sub === "/skills/remove") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					readJsonBody(req, MAX_SKILL_BYTES).then(async (raw) => {
						try {
							const skillName = cleanString(raw.name);
							if (skillName === void 0) throw new Error("skill 名称不能为空");
							removeSkillOnDisk(skillName);
							pruneInstalledRecords([skillName]);
							skillProvider.invalidate();
							sendJson(res, 200, { ok: true });
						} catch (error) {
							sendJson(res, 400, {
								ok: false,
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}, (error) => {
						sendJson(res, 400, {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
					});
					return;
				}
				if (sub === "/skills/update") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					readJsonBody(req, MAX_SKILL_BYTES).then(async (raw) => {
						try {
							const name = cleanString(raw.name);
							if (name === void 0) throw new Error("name 不能为空");
							const record = readInstalledRecords().find((entry) => entry.name === name);
							if (record === void 0) throw new Error(`没有「${name}」的安装记录，无法检查更新`);
							if (record.sourceUrl === void 0 || record.sourceUrl === "") throw new Error(`「${name}」是手写技能，没有来源仓库可更新`);
							const outcome = await importSkillFromGit({
								url: record.sourceUrl,
								name,
								...record.subPath !== void 0 && record.subPath !== "" ? { subPath: record.subPath } : {},
								...record.ref !== void 0 && record.ref !== "" ? { ref: record.ref } : {}
							});
							skillProvider.invalidate();
							const sha = outcome.sha;
							const changed = sha !== void 0 && record.sha !== void 0 && sha !== record.sha;
							if (sha !== void 0) upsertInstalledRecords([{
								...record,
								sha,
								installedAt: (/* @__PURE__ */ new Date()).toISOString()
							}]);
							sendJson(res, 200, {
								ok: true,
								changed,
								...sha !== void 0 ? { sha } : {},
								installed: outcome.installed
							});
						} catch (error) {
							sendJson(res, 400, {
								ok: false,
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}, (error) => {
						sendJson(res, 400, {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
					});
					return;
				}
				if (sub === "/session/followup") {
					if (method !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "仅支持 POST 请求"
						});
						return;
					}
					readJsonBody(req, MAX_SKILL_BYTES).then((raw) => {
						try {
							const request = raw;
							if (typeof request.prompt !== "string") throw new Error("prompt 必须是字符串");
							const result = submitFollowup(ctx, request);
							sendJson(res, result.ok ? 200 : 404, result);
						} catch (error) {
							sendJson(res, 400, {
								ok: false,
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}, (error) => {
						sendJson(res, 400, {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
					});
					return;
				}
				sendJson(res, 404, {
					ok: false,
					error: `未知的工作台路由：${sub}`
				});
			}
		});
		return () => {
			disposeRoutes();
		};
	}, "whaletv-workbench: http routes");
}
//#endregion
export { Config, apply, inject, name };
