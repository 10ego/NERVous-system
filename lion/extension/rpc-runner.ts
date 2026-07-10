/**
 * LION — RPC-backed runner.
 *
 * This runner is an explicit opt-in alternative to the legacy json subprocess
 * runner. It uses pi's official RPC mode so a running worker can receive real
 * mid-run steering through RpcClient.steer().
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { LionStore } from "./backend.ts";
import type { LionProgressSnapshot, LionReport } from "./schema.ts";
import { buildLionSystemPrompt, buildLionUserPrompt, createLionProgressState, isPidAlive, parseLionReport, progressFromEvent, signalProcessTree, type LionProcessInfo, type LionRunOutput, type LionRunRequest } from "./subprocess.ts";

export interface LionRpcClient {
	start(): Promise<void>;
	stop(): Promise<void>;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(timeout?: number): Promise<void>;
	getLastAssistantText(): Promise<string | null>;
	onEvent(listener: (event: unknown) => void): () => void;
	getStderr?(): string;
	getProcessInfo?(): LionProcessInfo | null;
	waitForExit?(): Promise<void>;
}

export interface LionRpcClientConfig {
	cwd: string;
	model?: string | null;
	tools?: string[] | null;
	systemPromptPath: string;
	extraArgs?: string[];
}

export interface LionRpcRunnerOptions {
	cwd: string;
	store: LionStore;
	extraArgs?: string[];
	/** Initial adaptive pending-steering poll delay. */
	pollIntervalMs?: number;
	/** Maximum adaptive pending-steering poll delay. */
	maxPollIntervalMs?: number;
	clientFactory?: (config: LionRpcClientConfig) => Promise<LionRpcClient> | LionRpcClient;
	/** Test/diagnostic hook invoked after the steering channel closes at idle. */
	onSteeringClosed?: () => Promise<void> | void;
	/** Maximum wait for graceful RPC abort before stop is attempted. */
	abortGraceMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_POLL_INTERVAL_MS = 2000;
const DEFAULT_ABORT_GRACE_MS = 1000;

interface DisposableWaiter<T> {
	promise: Promise<T>;
	dispose(reason?: Error): void;
}

function createDeadline(timeoutMs: number): DisposableWaiter<never> & { error(): Error | null } {
	let rejectPromise!: (error: Error) => void;
	let settled = false;
	let timeoutError: Error | null = null;
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		timeoutError = new Error(`LION RPC runner timed out after ${timeoutMs}ms`);
		rejectPromise(timeoutError);
	}, Math.max(0, timeoutMs));
	const promise = new Promise<never>((_, reject) => { rejectPromise = reject; });
	void promise.catch(() => undefined);
	return {
		promise,
		dispose() {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
		},
		error: () => timeoutError,
	};
}

function createIdleWaiter(client: LionRpcClient): DisposableWaiter<void> {
	let resolvePromise!: () => void;
	let rejectPromise!: (error: Error) => void;
	let settled = false;
	let unsubscribe: (() => void) | null = null;
	const finish = (error?: Error) => {
		if (settled) return;
		settled = true;
		try { unsubscribe?.(); } catch { /* ignore */ }
		unsubscribe = null;
		if (error) rejectPromise(error); else resolvePromise();
	};
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	unsubscribe = client.onEvent((event) => {
		if (typeof event === "object" && event !== null && (event as { type?: unknown }).type === "agent_end") finish();
	});
	void promise.catch(() => undefined);
	return { promise, dispose: (reason = new Error("RPC idle waiter disposed")) => finish(reason) };
}

export class AdaptivePoller {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private stopped = true;
	private nextDelay: number;

	constructor(
		private readonly task: () => Promise<boolean>,
		private readonly minDelayMs = DEFAULT_POLL_INTERVAL_MS,
		private readonly maxDelayMs = DEFAULT_MAX_POLL_INTERVAL_MS,
	) {
		this.nextDelay = minDelayMs;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.schedule(this.minDelayMs);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	wake(): void {
		this.nextDelay = this.minDelayMs;
		if (this.stopped || this.running) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.schedule(0);
	}

	private schedule(delay: number): void {
		if (this.stopped || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.tick();
		}, Math.max(0, delay));
		this.timer.unref?.();
	}

	private async tick(): Promise<void> {
		if (this.stopped || this.running) return;
		this.running = true;
		let hadWork = false;
		try { hadWork = await this.task(); }
		catch { /* polling is best-effort; retry with backoff */ }
		finally { this.running = false; }
		if (this.stopped) return;
		this.nextDelay = hadWork ? this.minDelayMs : Math.min(this.maxDelayMs, Math.max(this.minDelayMs, this.nextDelay * 2));
		this.schedule(this.nextDelay);
	}
}

async function writePromptToTempFile(label: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-lion-rpc-"));
	const safeName = label.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function createLionRpcRunner(opts: LionRpcRunnerOptions) {
	return async (req: LionRunRequest): Promise<LionRunOutput> => runRpcOnce(req, opts);
}

async function raceSession<T>(
	operation: () => Promise<T>,
	signal: AbortSignal | undefined,
	deadline: DisposableWaiter<never> & { error(): Error | null },
	onCancel: () => Promise<void>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};
		const cancel = (reason: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			void onCancel().then(() => reject(reason), reject);
		};
		const abort = () => cancel(new Error("LION RPC runner was aborted"));
		if (signal?.aborted) return abort();
		const expired = deadline.error();
		if (expired) return cancel(expired);
		signal?.addEventListener("abort", abort, { once: true });
		deadline.promise.then(undefined, (error) => cancel(error instanceof Error ? error : new Error(String(error))));
		let promise: Promise<T>;
		try { promise = operation(); }
		catch (error) { finish(() => reject(error)); return; }
		promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
	});
}

async function runRpcOnce(req: LionRunRequest, opts: LionRpcRunnerOptions): Promise<LionRunOutput> {
	if (req.signal?.aborted) throw new Error("LION RPC runner was aborted before prompt");
	const deadline = createDeadline(req.timeout_ms ?? 10 * 60_000);
	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	let client: LionRpcClient | null = null;
	let poller: AdaptivePoller | null = null;
	let deliveryPromise: Promise<boolean> | null = null;
	let stopPromise: Promise<void> | null = null;
	let unsubscribeEvents: (() => void) | null = null;
	let idleWaiter: DisposableWaiter<void> | null = null;
	let rawChildExit: Promise<void> | null = null;
	let processInfo: LionProcessInfo | null = null;
	let childAttached = false;
	let channelOpen = true;
	let childExited = false;
	let childIsAlive = () => false;
	let primaryError: unknown;
	let ownedCancellationRequested = false;
	let ownedCancellationPromise: Promise<void> | null = null;
	let sessionCancellationPromise: Promise<void> | null = null;
	let steeringClosedHook: Promise<void> = Promise.resolve();
	let processExitNotified = false;
	const notifyProcessExit = () => {
		if (processExitNotified) return;
		processExitNotified = true;
		try { req.onProcessExit?.(); } catch { /* best effort */ }
	};
	const stopClient = async () => {
		const activeClient = client;
		if (!activeClient) return;
		stopPromise ??= Promise.resolve().then(() => activeClient.stop());
		return stopPromise;
	};
	const abortAndStop = async (activeClient: LionRpcClient) => {
		let abortError: unknown;
		try {
			await withTimeout(activeClient.abort(), opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS, "RPC abort timed out");
		} catch (err) {
			abortError = err;
		}
		let stopError: unknown;
		try { await stopClient(); } catch (err) { stopError = err; }
		if (abortError) throw abortError;
		if (stopError) throw stopError;
	};
	const waitForConfirmedChildExit = async () => {
		while (childIsAlive()) {
			if (rawChildExit) {
				await rawChildExit;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		childExited = true;
	};
	const progressState = createLionProgressState({ includeText: req.include_progress_text ?? false });
	const closeSteeringChannel = () => {
		if (!channelOpen) return;
		channelOpen = false;
		poller?.stop();
		try { req.onControlClosed?.(); } catch { /* best effort */ }
		steeringClosedHook = Promise.resolve(opts.onSteeringClosed?.()).then(() => undefined);
	};
	const failReserved = async (messages: Array<{ id: string }>, reason: string) => {
		for (const msg of messages) {
			await opts.store.mutate((l) => l.markSteeringFailed(req.run.id, msg.id, reason)).catch(() => undefined);
		}
	};

	const deliverPending = async (): Promise<boolean> => {
		if (deliveryPromise) return deliveryPromise;
		if (!channelOpen || !client) return false;
		deliveryPromise = (async () => {
			const activeClient = client;
			if (!activeClient) return false;
			const { result: hasPending } = await opts.store.query((l) => l.hasPendingSteering(req.run.id));
			if (!channelOpen || !hasPending) return false;
			const { result: messages } = await opts.store.mutate((l) => l.reservePendingSteering(req.run.id));
			if (!channelOpen) {
				await failReserved(messages, "RPC steering channel closed before delivery");
				return false;
			}
			for (const msg of messages) {
				if (!channelOpen) {
					await opts.store.mutate((l) => l.markSteeringFailed(req.run.id, msg.id, "RPC steering channel closed before delivery")).catch(() => undefined);
					continue;
				}
				try {
					// No await may occur between this final gate check and issuing steer().
					const steering = activeClient.steer(msg.message);
					await steering;
					await opts.store.mutate((l) => l.markSteeringDelivered(req.run.id, msg.id));
				} catch (err) {
					await opts.store.mutate((l) => l.markSteeringFailed(req.run.id, msg.id, `RPC steer failed: ${err instanceof Error ? err.message : String(err)}`)).catch(() => undefined);
				}
			}
			return messages.length > 0;
		})().finally(() => { deliveryPromise = null; });
		return deliveryPromise;
	};

	const waitForInFlightDelivery = async () => {
		const inFlight: Promise<boolean> | null = deliveryPromise;
		if (inFlight) await inFlight.catch(() => undefined);
	};

	try {
		const tmp = await writePromptToTempFile(req.run.agent_id, buildLionSystemPrompt(req.run));
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
		client = await (opts.clientFactory ?? createDefaultRpcClient)({ cwd: opts.cwd, model: req.run.model, tools: req.run.tools, systemPromptPath: tmpPath, extraArgs: opts.extraArgs });
		const activeClient = client;

		unsubscribeEvents = activeClient.onEvent((event) => {
			const progress = progressFromEvent(event, progressState);
			if (progress) {
				try { req.onProgress?.(progress); } catch { /* progress callbacks must not break runner */ }
			}
		});
		const cancelSession = () => {
			closeSteeringChannel();
			sessionCancellationPromise ??= abortAndStop(activeClient);
			return sessionCancellationPromise;
		};
		await raceSession(() => activeClient.start(), req.signal, deadline, cancelSession);
		processInfo = activeClient.getProcessInfo?.() ?? null;
		if (processInfo?.pid) {
			childAttached = true;
			const processIsAlive = processInfo.isAlive ?? (() => !childExited);
			childIsAlive = () => !childExited && processIsAlive();
			rawChildExit = activeClient.waitForExit?.().then(() => { childExited = true; }) ?? null;
			if (rawChildExit) void rawChildExit.catch(() => undefined);
			try {
				req.onProcessStart?.({
					...processInfo,
					cancel: async (signal = "SIGTERM") => {
						if (!processIsAlive()) return false;
						ownedCancellationRequested = true;
						if (signal === "SIGKILL") return Boolean(await processInfo?.cancel?.("SIGKILL"));
						ownedCancellationPromise ??= abortAndStop(activeClient);
						await ownedCancellationPromise;
						return true;
					},
					isAlive: childIsAlive,
				});
			} catch { /* process metadata is best-effort */ }
		}

		idleWaiter = createIdleWaiter(activeClient);
		const idle = idleWaiter.promise.then(() => { closeSteeringChannel(); });
		void idle.catch(() => undefined);
		const childExit = rawChildExit?.then(async () => {
			closeSteeringChannel();
			if (ownedCancellationRequested) {
				await ownedCancellationPromise;
				throw new Error("LION RPC runner was cancelled");
			}
			throw new Error("LION RPC child exited before becoming idle");
		});
		if (childExit) void childExit.catch(() => undefined);
		await raceSession(
			() => childExit ? Promise.race([activeClient.prompt(buildLionUserPrompt(req.run)), childExit]) : activeClient.prompt(buildLionUserPrompt(req.run)),
			req.signal,
			deadline,
			cancelSession,
		);
		poller = new AdaptivePoller(deliverPending, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, opts.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS);
		if (channelOpen) poller.start();
		if (channelOpen && await raceSession(() => deliverPending(), req.signal, deadline, cancelSession)) poller.wake();
		await raceSession(() => childExit ? Promise.race([idle, childExit]) : idle, req.signal, deadline, cancelSession);
		if (ownedCancellationRequested) {
			await ownedCancellationPromise;
			throw new Error("LION RPC runner was cancelled");
		}
		closeSteeringChannel();
		await steeringClosedHook;
		await waitForInFlightDelivery();
		await opts.store.mutate((l) => l.failOpenSteering(req.run.id, "run finished before pending steering could be delivered"));
		const text = (await activeClient.getLastAssistantText()) ?? "";
		const report: LionReport | null = parseLionReport(text);
		return { text, report };
	} catch (err) {
		primaryError = err;
		closeSteeringChannel();
		await steeringClosedHook.catch(() => undefined);
		await opts.store.mutate((l) => l.failOpenSteering(req.run.id, `RPC runner stopped before delivery: ${err instanceof Error ? err.message : String(err)}`)).catch(() => undefined);
		throw err;
	} finally {
		deadline.dispose();
		closeSteeringChannel();
		idleWaiter?.dispose();
		poller?.stop();
		try { unsubscribeEvents?.(); } catch { /* ignore */ }
		let stopError: unknown;
		try { await stopClient(); } catch (err) { stopError = err; }
		if (childAttached && childIsAlive() && stopError) {
			try { await processInfo?.cancel?.("SIGKILL"); } catch { /* retain ownership until actual exit */ }
		}
		if (childAttached && childIsAlive()) await waitForConfirmedChildExit();
		if (!childAttached || !childIsAlive()) notifyProcessExit();
		if (tmpPath)
			try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		if (tmpDir)
			try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
		if (stopError && !primaryError) throw stopError;
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), Math.max(0, timeoutMs));
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function createDefaultRpcClient(config: LionRpcClientConfig): Promise<LionRpcClient> {
	const mod = await import("@earendil-works/pi-coding-agent");
	const cliPath = path.join(mod.getPackageDir(), "dist", "cli.js");
	const args = ["--no-session", "--append-system-prompt", config.systemPromptPath, ...(config.extraArgs ?? [])];
	if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));
	const client = new mod.RpcClient({ cliPath, cwd: config.cwd, model: config.model ?? undefined, args });
	return {
		start: () => client.start(),
		stop: () => client.stop(),
		prompt: (message) => client.prompt(message),
		steer: (message) => client.steer(message),
		abort: () => client.abort(),
		waitForIdle: (timeout) => client.waitForIdle(timeout),
		getLastAssistantText: () => client.getLastAssistantText(),
		onEvent: (listener) => client.onEvent(listener as never),
		getStderr: () => client.getStderr(),
		getProcessInfo: () => {
			const proc = (client as unknown as { process?: { pid?: number; exitCode?: number | null; signalCode?: string | null } | null }).process;
			if (typeof proc?.pid !== "number") return null;
			const pid = proc.pid;
			const isAlive = () => proc.exitCode == null && proc.signalCode == null && isPidAlive(pid);
			return {
				pid,
				pgid: null,
				isAlive,
				cancel: (signal = "SIGTERM") => {
					if (!isAlive()) return false;
					signalProcessTree(pid, signal);
					return true;
				},
			};
		},
		waitForExit: async () => {
			const proc = (client as unknown as { process?: { exitCode?: number | null; signalCode?: string | null; once?: (event: string, listener: () => void) => void } | null }).process;
			if (!proc || proc.exitCode != null || proc.signalCode != null || !proc.once) return;
			await new Promise<void>((resolve) => {
				let settled = false;
				const done = () => { if (!settled) { settled = true; resolve(); } };
				proc.once!("exit", done);
				proc.once!("error", done);
			});
		},
	};
}
