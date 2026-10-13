/**
 * dsh-connect-officeace 的浏览器半边。
 *
 * 职责只有一个：在输入框工具栏（`conversation.input.left`）显示 OfficeAce 的
 * 积分余额，与 `dsh-connect-trae` 的输入框读数同构：
 *
 *   - **只在当前会话选中的模型属于本插件时渲染**。输入框工具栏是与权限/专家/
 *     模型选择器共享的一行，两个连接器插件各占一格必然互相挤压；按 provider
 *     收窄后同一时刻只有一个插件的余额是相关的，也不会重叠。
 *   - **5 分钟轮询**。积分以「模型调用」为粒度变化，更短的周期没有边际价值，
 *     而每次读数都要打一次本地 API。
 *   - **OfficeAce 未运行时不渲染、不报错**。读数失败时保留上一次的数值，只有
 *     从未拿到过数值时才留空；一个变旧的数字好过一个消失的控件。
 *
 * 本文件是 DSH 客户端模块系统的 bundle 入口（与 Trae/Qoder 一致），格式为
 * `window.__ModuleLoader__.load({ id, factory })`。只依赖 `react` 与
 * `react/jsx-runtime`：宿主自带的 Client 包不作为模块加载（DSH 插件开发实践
 * 明确禁止），控件与样式全部自绘，只引用 `--dsw-alias-*` 主题令牌。
 *
 * Host 侧路由见 `lib/index.js` 的 `OFFICEACE_CREDITS_PATH`。
 */

window.__ModuleLoader__.load({
	id: "dsh-connect-officeace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let jsx = react_jsx_runtime.jsx;
		let jsxs = react_jsx_runtime.jsxs;
		let Fragment = react.Fragment;

		/** 与 Host 侧 `OFFICEACE_CREDITS_PATH` 保持一致。 */
		const CREDITS_PATH = "/plugins/dsh-connect-officeace/credits";
		/** 自动刷新周期；Host 在下发文档里也带这个值，客户端以 Host 为准。 */
		const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
		/** 本插件注册的 provider 路由 id。 */
		const PROVIDER = "officeace";

		/**
		 * 读数样式，在模块加载时一次性注入文档头。
		 *
		 * 自注入而不是依赖宿主的样式表：这个组件挂在输入框工具栏里，宿主只为
		 * 自己的控件提供布局，插件的条目必须自己带齐全部规则。注入是幂等的
		 * （按 `data-plugin-css` 去重），与 Trae 的同名机制一致。
		 */
		const CREDITS_CSS = `
.dsm-officeace-credits{display:inline-flex;align-items:center;min-width:0}
.dsm-officeace-credits-trigger{
  display:inline-flex;align-items:center;gap:6px;
  /* EXPLICIT，不继承：输入框行有自己的字号与配色，读数是次要信息，不能抢戏。 */
  padding:2px 6px;margin:0;border:0;border-radius:6px;
  font:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));
  background:transparent;cursor:pointer;
  transition:background-color .15s,color .15s;
}
.dsm-officeace-credits-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-officeace-credits-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-officeace-credits-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:currentColor;opacity:.7}
.dsm-officeace-credits-value{font-variant-numeric:tabular-nums}
.dsm-officeace-credits-panel{
  position:fixed;z-index:60;min-width:220px;max-width:320px;
  display:flex;flex-direction:column;gap:8px;
  padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;
  background:var(--dsw-alias-bg-layer-3,#2a2c33);
  box-shadow:0 8px 24px rgba(0,0,0,.28);
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8);
}
.dsm-officeace-credits-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsm-officeace-credits-panel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-officeace-credits-refresh{
  padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:6px;
  font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary,#b8b8b8);
  background:transparent;cursor:pointer;
}
.dsm-officeace-credits-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.6))}
.dsm-officeace-credits-refresh:disabled{opacity:.5;cursor:default}
.dsm-officeace-credits-summary{display:flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-officeace-credits-summary b{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.dsm-officeace-credits-rows{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.dsm-officeace-credits-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsm-officeace-credits-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-officeace-credits-row-num{flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-officeace-credits-row[data-expired="true"] .dsm-officeace-credits-row-name,
.dsm-officeace-credits-row[data-expired="true"] .dsm-officeace-credits-row-num{opacity:.55;text-decoration:line-through}
.dsm-officeace-credits-note{margin:0;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}
.dsm-officeace-credits-error{margin:0;color:var(--dsw-alias-state-error-primary,#d92d20)}
`;
		const CSS_ID = "dsh-connect-officeace/credits.css";
		if (typeof document !== "undefined") {
			if (!document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-connect-officeace";
				styleTag.dataset.pluginCss = CSS_ID;
				styleTag.textContent = CREDITS_CSS;
				document.head.appendChild(styleTag);
			}
		}

		/**
		 * 会话当前指向的 provider 路由。
		 *
		 * `next` 压过 `lastUsed`：一次已经落盘但还没发出去的选择，仍然是输入框
		 * 展示给用户的那一个。读的是 Host 自己的 `modelSelection` 投影，因此
		 * 读数不可能与真正生效的模型不一致。
		 *
		 * @param {unknown} projection - `useProjection("modelSelection")` 的快照。
		 * @returns {string | undefined} provider 路由 id。
		 */
		function selectedProviderOf(projection) {
			const provider = (projection?.next ?? projection?.lastUsed)?.provider;
			return typeof provider === "string" && provider !== "" ? provider : void 0;
		}

		/** 千分位；小数额保留两位，让「0.32」不会被抹成 0。 */
		function formatCredits(value) {
			if (!Number.isFinite(value)) return "—";
			const rounded = Math.round(value * 100) / 100;
			return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
		}

		/** 从读数文档里取「可用余额」；无上限套餐返回 undefined。 */
		function remainingOf(doc) {
			if (doc?.status !== "available") return void 0;
			if (doc.unlimited === true) return void 0;
			return typeof doc.remaining === "number" ? doc.remaining : void 0;
		}

		/**
		 * 读一次积分文档。失败一律返回 null，由调用方保留旧值。
		 * @param {AbortSignal} [signal] - 调用方信号。
		 * @returns {Promise<object | null>} 宿主下发的文档。
		 */
		async function fetchCredits(signal) {
			try {
				const response = await fetch(CREDITS_PATH, {
					headers: { accept: "application/json" },
					credentials: "same-origin",
					...(signal === void 0 ? {} : { signal }),
				});
				if (!response.ok) return null;
				return await response.json();
			} catch {
				return null;
			}
		}

		/**
		 * 输入框工具栏的积分读数。
		 *
		 * 整块是一个按钮：点击打开锚定浮层，浮层里是套餐概览与各积分组的
		 * remaining/total/到期时间，以及手动刷新按钮。没有行内刷新按钮——
		 * 这一行与权限/专家/模型控件共享宽度，必须保持窄。
		 */
		function CreditsReadout(props) {
			const { t, useProjection } = props;
			const projection = useProjection === void 0 ? void 0 : useProjection("modelSelection");
			const provider = selectedProviderOf(projection);

			const [doc, setDoc] = react.useState(void 0);
			const [open, setOpen] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [failed, setFailed] = react.useState(false);
			const [position, setPosition] = react.useState(null);
			const rootRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const inFlight = react.useRef(false);
			const mounted = react.useRef(true);

			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);

			const read = react.useCallback(async () => {
				if (inFlight.current) return;
				inFlight.current = true;
				if (mounted.current) setBusy(true);
				try {
					const value = await fetchCredits();
					if (!mounted.current) return;
					if (value === null) {
						// 读失败保留旧值：一个变旧的数字好过一个消失的控件。
						setFailed(true);
					} else {
						setDoc(value);
						setFailed(false);
					}
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			}, []);

			// 轮询只在 provider 命中时启动；选到别的供应商时整块不渲染，
			// 循环也随之停止，不为一个没人看的读数打本地 API。
			react.useEffect(() => {
				if (provider !== PROVIDER) return void 0;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					void read();
				}, REFRESH_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [provider, read]);

			// 首次命中 provider 时立即读一次，不必等一个周期。
			react.useEffect(() => {
				if (provider !== PROVIDER) return;
				void read();
			}, [provider, read]);

			// Esc 关闭浮层。
			react.useEffect(() => {
				if (!open) return void 0;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			// 点击浮层外关闭。
			react.useEffect(() => {
				if (!open) return void 0;
				const onPointerDown = (event) => {
					const target = event.target;
					if (!(target instanceof Node)) return;
					if (rootRef.current?.contains(target)) return;
					if (panelRef.current?.contains(target)) return;
					setOpen(false);
				};
				document.addEventListener("mousedown", onPointerDown);
				return () => {
					document.removeEventListener("mousedown", onPointerDown);
				};
			}, [open]);

			// 打开时按锚点定位；量不到就藏起来等下一帧，绝不画在 (0,0)。
			react.useEffect(() => {
				if (!open) {
					setPosition(null);
					return;
				}
				const place = () => {
					const anchor = rootRef.current;
					if (anchor === null) return;
					const rect = anchor.getBoundingClientRect();
					setPosition({ top: rect.bottom + 6, left: rect.left });
				};
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [open]);

			if (provider !== PROVIDER) return null;

			const remaining = remainingOf(doc);
			const valueText = remaining === void 0 ? "—" : formatCredits(remaining);
			const label = t("credits.label");

			return jsxs(Fragment, {
				children: [
					jsx("span", {
						ref: rootRef,
						className: "dsm-officeace-credits",
						children: jsxs("button", {
							type: "button",
							className: "dsm-officeace-credits-trigger",
							"aria-haspopup": "dialog",
							"aria-expanded": open,
							onClick: () => {
								setOpen(!open);
							},
							children: [
								jsx("span", { className: "dsm-officeace-credits-dot", "aria-hidden": true }),
								label,
								" · ",
								jsx("span", { className: "dsm-officeace-credits-value", children: valueText }),
							],
						}),
					}),
					open && jsx(Panel, { doc, busy, failed, position, panelRef, onRefresh: read, t }),
				],
			});
		}

		/**
		 * 浮层：套餐概览 + 各积分组明细。
		 *
		 * 组明细按上游顺序原样列出（含已过期的），因为「为什么余额比昨天少」
		 * 的答案就在过期行里。无上限套餐不显示具体数字，只标「无上限」。
		 */
		function Panel(props) {
			const { doc, busy, failed, position, panelRef, onRefresh, t } = props;
			const style = position ?? { visibility: "hidden", top: 0, left: 0 };
			const groups = Array.isArray(doc?.groups) ? doc.groups : [];

			return jsxs("div", {
				ref: panelRef,
				className: "dsm-officeace-credits-panel",
				style,
				role: "dialog",
				"aria-label": t("credits.panelTitle"),
				children: [
					jsxs("div", {
						className: "dsm-officeace-credits-panel-head",
						children: [
							jsx("span", { className: "dsm-officeace-credits-panel-title", children: t("credits.panelTitle") }),
							jsx("button", {
								type: "button",
								className: "dsm-officeace-credits-refresh",
								disabled: busy,
								onClick: () => {
									void onRefresh();
								},
								children: busy ? t("credits.refreshing") : t("credits.refresh"),
							}),
						],
					}),
					doc?.status === "unreachable"
						? jsx("p", { className: "dsm-officeace-credits-note", children: t("credits.offline") })
						: doc?.status !== "available"
							? jsx("p", { className: "dsm-officeace-credits-note", children: t("credits.unavailable") })
							: jsxs(Fragment, {
									children: [
										jsxs("div", {
											className: "dsm-officeace-credits-summary",
											children: [
												jsx("b", { children: doc.unlimited === true ? "∞" : formatCredits(doc.remaining ?? 0) }),
												jsx("span", { children: doc.planName ?? t("credits.unknownPlan") }),
											],
										}),
										groups.length > 0
											? jsx("ul", {
													className: "dsm-officeace-credits-rows",
													children: groups.map((group) =>
														jsxs("li", {
															className: "dsm-officeace-credits-row",
															"data-expired": group.expired === true ? "true" : "false",
															children: [
																jsx("span", { className: "dsm-officeace-credits-row-name", children: group.name }),
																jsx("span", {
																	className: "dsm-officeace-credits-row-num",
																	children: group.unlimited === true
																		? t("credits.unlimited")
																		: `${formatCredits(group.remaining ?? 0)} / ${formatCredits(group.total ?? 0)}`,
																}),
															],
														}, group.key),
													),
												})
											: null,
										jsx("p", {
											className: "dsm-officeace-credits-note",
											children: t("credits.hint"),
										}),
									],
								}),
					failed ? jsx("p", { className: "dsm-officeace-credits-error", children: t("credits.refreshFailed") }) : null,
				],
			});
		}

		/** 浏览器插件名。 */
		const name = "dsh-connect-officeace-client";
		/**
		 * 只依赖 slots 与 locale：这两个服务在 0.1.7 线上无条件提供。
		 * `useProjection` 通过框架 props 注入，缺席时读数不渲染（见
		 * `CreditsReadout`），因此不需要把它列进 inject。
		 */
		const inject = ["slots", "locale"];

		/**
		 * 注册文案与输入框读数。
		 *
		 * 整个函数体被 try/catch 包住：DSH 槽位 API 的一次破坏性改动应该降级成
		 * 一条 console.error，而不是抛进 loader 顶起「插件加载失败」的红条。
		 * 宿主那半边（provider 注册）与此完全独立，照样能用。
		 */
		function apply(ctx) {
			try {
				const namespace = "settings.officeace";
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-connect-officeace: credits copy");
				const t = ctx.locale.bind(namespace);

				/**
				 * 输入框工具栏的积分读数（`conversation.input.left`，session 作用域的
				 * list 槽位）。
				 *
				 * 按 provider 收窄是这里的全部要点：侧边栏底部是一条根级共享行，
				 * 两个连接器插件各占一格必然互相挤压；输入框工具栏按会话、按供应商，
				 * 同一时刻只有一个插件的余额是相关的。注册是无条件的，闸门读 Host 的
				 * modelSelection 投影，对其它 provider 一律返回 null —— 不绘制，也不
				 * 启动轮询。
				 */
				try {
					ctx.slots.inject("conversation.input.left", () =>
						ctx.slots.register({
							name: "conversation.input.left",
							id: "dsh-connect-officeace-credits",
							order: 4,
							locale: namespace,
							inject: () => ({ t }),
						}, CreditsReadout),
					);
				} catch (error) {
					console.error("[dsh-connect-officeace] credits slot failed to register (host provider unaffected):", error);
				}
			} catch (error) {
				console.error("[dsh-connect-officeace] client failed to load (host provider unaffected):", error);
			}
		}

		//#region locales
		const en = {
			"credits.label": "OfficeAce",
			"credits.panelTitle": "OfficeAce credits",
			"credits.refresh": "Refresh",
			"credits.refreshing": "Refreshing…",
			"credits.refreshFailed": "Could not refresh credits",
			"credits.offline": "OfficeAce is not running",
			"credits.unavailable": "Credits unavailable",
			"credits.unknownPlan": "current plan",
			"credits.unlimited": "Unlimited",
			"credits.hint": "Read from OfficeAce's local service; model calls are unaffected when it is closed.",
		};
		const zh = {
			"credits.label": "OfficeAce",
			"credits.panelTitle": "OfficeAce 积分",
			"credits.refresh": "刷新",
			"credits.refreshing": "正在刷新…",
			"credits.refreshFailed": "积分刷新失败",
			"credits.offline": "OfficeAce 未运行",
			"credits.unavailable": "积分暂不可读",
			"credits.unknownPlan": "当前套餐",
			"credits.unlimited": "无上限",
			"credits.hint": "读数来自 OfficeAce 本地服务；它未运行时不影响模型调用。",
		};
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
