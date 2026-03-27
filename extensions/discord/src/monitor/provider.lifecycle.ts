import type { Client } from "@buape/carbon";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import { createConnectedChannelStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { attachDiscordGatewayLogging } from "../gateway-logging.js";
import { getDiscordGatewayEmitter, waitForDiscordGatewayStop } from "../monitor.gateway.js";
import type { DiscordVoiceManager } from "../voice/manager.js";
import type { DiscordGatewaySocket, MutableDiscordGateway } from "./gateway-handle.js";
import { registerGateway, unregisterGateway } from "./gateway-registry.js";
import type { DiscordGatewayEvent, DiscordGatewaySupervisor } from "./gateway-supervisor.js";
import type { DiscordMonitorStatusSink } from "./status.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCORD_GATEWAY_READY_TIMEOUT_MS = 15_000;
const DISCORD_GATEWAY_READY_POLL_MS = 250;
const DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS = 5_000;
const DISCORD_GATEWAY_FORCE_TERMINATE_CLOSE_TIMEOUT_MS = 1_000;
const DISCORD_GATEWAY_HELLO_TIMEOUT_MS = 30_000;
const DISCORD_GATEWAY_HELLO_CONNECTED_POLL_MS = 250;
const DISCORD_GATEWAY_MAX_CONSECUTIVE_HELLO_STALLS = 3;
const DISCORD_GATEWAY_RECONNECT_STALL_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// waitForDiscordGatewayReady
// ---------------------------------------------------------------------------

type GatewayReadyWaitResult = "ready" | "timeout" | "stopped";

async function waitForDiscordGatewayReady(params: {
  gateway?: Pick<MutableDiscordGateway, "isConnected">;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  beforePoll?: () => Promise<"continue" | "stop"> | "continue" | "stop";
}): Promise<GatewayReadyWaitResult> {
  const deadlineAt = Date.now() + params.timeoutMs;
  while (!params.abortSignal?.aborted) {
    const pollDecision = await params.beforePoll?.();
    if (pollDecision === "stop") {
      return "stopped";
    }
    if (params.gateway?.isConnected) {
      return "ready";
    }
    if (Date.now() >= deadlineAt) {
      return "timeout";
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, DISCORD_GATEWAY_READY_POLL_MS);
      timeout.unref?.();
    });
  }
  return "stopped";
}

// ---------------------------------------------------------------------------
// Reconnect controller (inlined from provider.lifecycle.reconnect.ts)
// ---------------------------------------------------------------------------

function createDiscordGatewayReconnectController(params: {
  accountId: string;
  gateway?: MutableDiscordGateway;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  pushStatus: (patch: Parameters<DiscordMonitorStatusSink>[0]) => void;
  isLifecycleStopping: () => boolean;
  drainPendingGatewayErrors: () => "continue" | "stop";
}) {
  let forceStopHandler: ((err: unknown) => void) | undefined;
  let queuedForceStopError: unknown;
  let helloTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let helloConnectedPollId: ReturnType<typeof setInterval> | undefined;
  let reconnectInFlight: Promise<void> | undefined;
  let consecutiveHelloStalls = 0;

  const shouldStop = () => params.isLifecycleStopping() || (params.abortSignal?.aborted ?? false);

  const resetHelloStallCounter = () => {
    consecutiveHelloStalls = 0;
  };

  const clearHelloWatch = () => {
    if (helloTimeoutId) {
      clearTimeout(helloTimeoutId);
      helloTimeoutId = undefined;
    }
    if (helloConnectedPollId) {
      clearInterval(helloConnectedPollId);
      helloConnectedPollId = undefined;
    }
  };

  const parseGatewayCloseCode = (message: string): number | undefined => {
    const match = /code\s+(\d{3,5})/i.exec(message);
    if (!match?.[1]) return undefined;
    const code = Number.parseInt(match[1], 10);
    return Number.isFinite(code) ? code : undefined;
  };

  const clearResumeState = () => {
    if (!params.gateway?.state) return;
    params.gateway.state.sessionId = null;
    params.gateway.state.resumeGatewayUrl = null;
    params.gateway.state.sequence = null;
    params.gateway.sequence = null;
  };

  const triggerForceStop = (err: unknown) => {
    if (forceStopHandler) {
      forceStopHandler(err);
      return;
    }
    queuedForceStopError = err;
  };

  // Reconnect stall watchdog — fires if reconnect takes too long.
  let reconnectStallWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectStallArmedAt: number | undefined;

  const disarmReconnectStallWatchdog = () => {
    if (reconnectStallWatchdogTimer) {
      clearTimeout(reconnectStallWatchdogTimer);
      reconnectStallWatchdogTimer = undefined;
    }
    reconnectStallArmedAt = undefined;
  };

  const armReconnectStallWatchdog = (at: number) => {
    disarmReconnectStallWatchdog();
    reconnectStallArmedAt = at;
    reconnectStallWatchdogTimer = setTimeout(() => {
      reconnectStallWatchdogTimer = undefined;
      if (shouldStop()) return;
      const error = new Error(
        `discord reconnect watchdog timeout after ${DISCORD_GATEWAY_RECONNECT_STALL_TIMEOUT_MS}ms`,
      );
      params.pushStatus({
        connected: false,
        lastEventAt: at,
        lastDisconnect: { at, error: error.message },
        lastError: error.message,
      });
      params.runtime.error?.(
        danger(
          `discord: reconnect watchdog timeout after ${DISCORD_GATEWAY_RECONNECT_STALL_TIMEOUT_MS}ms; force-stopping monitor task`,
        ),
      );
      triggerForceStop(error);
    }, DISCORD_GATEWAY_RECONNECT_STALL_TIMEOUT_MS);
  };

  const pushConnectedStatus = (at: number) => {
    params.pushStatus({
      ...createConnectedChannelStatusPatch(at),
      lastDisconnect: null,
    });
  };

  const disconnectGatewaySocketWithoutAutoReconnect = async () => {
    if (!params.gateway) return;
    const gateway = params.gateway;
    const socket = gateway.ws as DiscordGatewaySocket | null | undefined;

    if (!socket) {
      gateway.disconnect();
      return;
    }

    // Carbon reconnects from the socket close handler even for intentional
    // disconnects. Drop the current socket's close/error listeners so a forced
    // reconnect does not race the old socket's automatic resume path.
    {
      for (const listener of socket.listeners("close")) {
        socket.removeListener("close", listener);
      }
      for (const listener of socket.listeners("error")) {
        socket.removeListener("error", listener);
      }
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let drainTimeout: ReturnType<typeof setTimeout> | undefined;
      let terminateCloseTimeout: ReturnType<typeof setTimeout> | undefined;
      const ignoreSocketError = () => {};

      const clearPendingTimers = () => {
        if (drainTimeout) {
          clearTimeout(drainTimeout);
          drainTimeout = undefined;
        }
        if (terminateCloseTimeout) {
          clearTimeout(terminateCloseTimeout);
          terminateCloseTimeout = undefined;
        }
      };

      const cleanup = () => {
        clearPendingTimers();
        socket.removeListener("close", onClose);
        socket.removeListener("error", ignoreSocketError);
      };

      const onClose = () => {
        cleanup();
        if (settled) return;
        settled = true;
        resolve();
      };

      const resolveStoppedWait = () => {
        if (settled) return;
        settled = true;
        clearPendingTimers();
        resolve();
      };

      const rejectClose = (error: Error) => {
        if (shouldStop()) {
          resolveStoppedWait();
          return;
        }
        if (settled) return;
        settled = true;
        clearPendingTimers();
        reject(error);
      };

      drainTimeout = setTimeout(() => {
        if (settled) return;
        if (shouldStop()) {
          resolveStoppedWait();
          return;
        }

        params.runtime.error?.(
          danger(
            `discord: gateway socket did not close within ${DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS}ms before reconnect; attempting forced terminate before giving up`,
          ),
        );

        let terminateStarted = false;
        try {
          if (typeof socket.terminate === "function") {
            socket.terminate();
            terminateStarted = true;
          }
        } catch {
          // best-effort
        }

        if (!terminateStarted) {
          params.runtime.error?.(
            danger(
              `discord: gateway socket did not expose a working terminate() after ${DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS}ms; force-stopping instead of opening a parallel socket`,
            ),
          );
          rejectClose(
            new Error(
              `discord gateway socket did not close within ${DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS}ms before reconnect`,
            ),
          );
          return;
        }

        terminateCloseTimeout = setTimeout(() => {
          if (settled) return;
          if (shouldStop()) {
            resolveStoppedWait();
            return;
          }
          params.runtime.error?.(
            danger(
              `discord: gateway socket did not close ${DISCORD_GATEWAY_FORCE_TERMINATE_CLOSE_TIMEOUT_MS}ms after forced terminate; force-stopping instead of opening a parallel socket`,
            ),
          );
          rejectClose(
            new Error(
              `discord gateway socket did not close within ${DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS}ms before reconnect`,
            ),
          );
        }, DISCORD_GATEWAY_FORCE_TERMINATE_CLOSE_TIMEOUT_MS);
        terminateCloseTimeout.unref?.();
      }, DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS);
      drainTimeout.unref?.();

      socket.on("error", ignoreSocketError);
      socket.on("close", onClose);
      gateway.disconnect();
    });
  };

  const reconnectGateway = async (reconnectParams: {
    resume: boolean;
    forceFreshIdentify?: boolean;
  }) => {
    if (reconnectInFlight) {
      return await reconnectInFlight;
    }
    reconnectInFlight = (async () => {
      if (reconnectParams.forceFreshIdentify) {
        clearResumeState();
      }
      if (shouldStop()) return;
      await disconnectGatewaySocketWithoutAutoReconnect();
      if (shouldStop()) return;
      params.gateway?.connect(reconnectParams.resume);
    })().finally(() => {
      reconnectInFlight = undefined;
    });
    return await reconnectInFlight;
  };

  const reconnectGatewayFresh = async () => {
    await reconnectGateway({ resume: false, forceFreshIdentify: true });
  };

  const onGatewayDebug = (msg: unknown) => {
    const message = String(msg);
    const at = Date.now();
    params.pushStatus({ lastEventAt: at });

    if (message.includes("WebSocket connection closed")) {
      if (params.gateway?.isConnected) {
        resetHelloStallCounter();
      }
      armReconnectStallWatchdog(at);
      params.pushStatus({
        connected: false,
        lastDisconnect: {
          at,
          status: parseGatewayCloseCode(message),
        },
      });
      clearHelloWatch();
      return;
    }

    if (!message.includes("WebSocket connection opened")) {
      return;
    }

    disarmReconnectStallWatchdog();
    clearHelloWatch();

    let sawConnected = params.gateway?.isConnected === true;
    if (sawConnected) {
      pushConnectedStatus(at);
    }

    helloConnectedPollId = setInterval(() => {
      if (!params.gateway?.isConnected) return;
      sawConnected = true;
      resetHelloStallCounter();
      disarmReconnectStallWatchdog();
      pushConnectedStatus(Date.now());
      if (helloConnectedPollId) {
        clearInterval(helloConnectedPollId);
        helloConnectedPollId = undefined;
      }
    }, DISCORD_GATEWAY_HELLO_CONNECTED_POLL_MS);

    helloTimeoutId = setTimeout(() => {
      helloTimeoutId = undefined;
      void (async () => {
        try {
          if (helloConnectedPollId) {
            clearInterval(helloConnectedPollId);
            helloConnectedPollId = undefined;
          }
          if (sawConnected || params.gateway?.isConnected) {
            resetHelloStallCounter();
            return;
          }

          consecutiveHelloStalls += 1;
          const forceFreshIdentify =
            consecutiveHelloStalls >= DISCORD_GATEWAY_MAX_CONSECUTIVE_HELLO_STALLS;
          const stalledAt = Date.now();
          armReconnectStallWatchdog(stalledAt);
          params.pushStatus({
            connected: false,
            lastEventAt: stalledAt,
            lastDisconnect: { at: stalledAt, error: "hello-timeout" },
          });
          params.runtime.log?.(
            danger(
              forceFreshIdentify
                ? `connection stalled: no HELLO within ${DISCORD_GATEWAY_HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${DISCORD_GATEWAY_MAX_CONSECUTIVE_HELLO_STALLS}); forcing fresh identify`
                : `connection stalled: no HELLO within ${DISCORD_GATEWAY_HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${DISCORD_GATEWAY_MAX_CONSECUTIVE_HELLO_STALLS}); retrying resume`,
            ),
          );
          if (forceFreshIdentify) {
            resetHelloStallCounter();
          }
          if (shouldStop()) return;
          if (forceFreshIdentify) {
            await reconnectGatewayFresh();
            return;
          }
          await reconnectGateway({ resume: true });
        } catch (err) {
          params.runtime.error?.(
            danger(`discord: failed to restart stalled gateway socket: ${String(err)}`),
          );
          triggerForceStop(err);
        }
      })();
    }, DISCORD_GATEWAY_HELLO_TIMEOUT_MS);
  };

  const onAbort = () => {
    disarmReconnectStallWatchdog();
    const at = Date.now();
    params.pushStatus({ connected: false, lastEventAt: at });
    if (!params.gateway) return;
    params.gateway.options.reconnect = { maxAttempts: 0 };
    params.gateway.disconnect();
  };

  const ensureStartupReady = async () => {
    if (!params.gateway || params.gateway.isConnected || shouldStop()) {
      if (params.gateway?.isConnected && !shouldStop()) {
        pushConnectedStatus(Date.now());
      }
      return;
    }

    const initialReady = await waitForDiscordGatewayReady({
      gateway: params.gateway,
      abortSignal: params.abortSignal,
      timeoutMs: DISCORD_GATEWAY_READY_TIMEOUT_MS,
      beforePoll: params.drainPendingGatewayErrors,
    });
    if (initialReady === "stopped" || shouldStop()) return;

    if (initialReady === "timeout") {
      params.runtime.error?.(
        danger(
          `discord: gateway was not ready after ${DISCORD_GATEWAY_READY_TIMEOUT_MS}ms; forcing a fresh reconnect`,
        ),
      );
      const startupRetryAt = Date.now();
      params.pushStatus({
        connected: false,
        lastEventAt: startupRetryAt,
        lastDisconnect: { at: startupRetryAt, error: "startup-not-ready" },
      });
      await reconnectGatewayFresh();
      const reconnected = await waitForDiscordGatewayReady({
        gateway: params.gateway,
        abortSignal: params.abortSignal,
        timeoutMs: DISCORD_GATEWAY_READY_TIMEOUT_MS,
        beforePoll: params.drainPendingGatewayErrors,
      });
      if (reconnected === "stopped" || shouldStop()) return;
      if (reconnected === "timeout") {
        const error = new Error(
          `discord gateway did not reach READY within ${DISCORD_GATEWAY_READY_TIMEOUT_MS}ms after a forced reconnect`,
        );
        const startupFailureAt = Date.now();
        params.pushStatus({
          connected: false,
          lastEventAt: startupFailureAt,
          lastDisconnect: { at: startupFailureAt, error: "startup-reconnect-timeout" },
          lastError: error.message,
        });
        throw error;
      }
    }

    if (params.gateway.isConnected && !shouldStop()) {
      pushConnectedStatus(Date.now());
    }
  };

  if (params.abortSignal?.aborted) {
    onAbort();
  } else {
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  return {
    ensureStartupReady,
    onAbort,
    onGatewayDebug,
    clearHelloWatch,
    registerForceStop: (handler: (err: unknown) => void) => {
      forceStopHandler = handler;
      if (queuedForceStopError !== undefined) {
        const queued = queuedForceStopError;
        queuedForceStopError = undefined;
        handler(queued);
      }
    },
    dispose: () => {
      disarmReconnectStallWatchdog();
      clearHelloWatch();
      params.abortSignal?.removeEventListener("abort", onAbort);
    },
  };
}

// ---------------------------------------------------------------------------
// Public lifecycle entry point
// ---------------------------------------------------------------------------

type ExecApprovalsHandler = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function runDiscordGatewayLifecycle(params: {
  accountId: string;
  /** Carbon Client — used by provider.ts; gateway is derived via getPlugin. */
  client?: Client;
  /** GatewayPlugin directly — used by tests. Takes precedence over client. */
  gateway?: MutableDiscordGateway;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  isDisallowedIntentsError: (err: unknown) => boolean;
  voiceManager: DiscordVoiceManager | null;
  voiceManagerRef: { current: DiscordVoiceManager | null };
  execApprovalsHandler: ExecApprovalsHandler | null;
  threadBindings: { stop: () => void };
  gatewaySupervisor: DiscordGatewaySupervisor;
  statusSink?: DiscordMonitorStatusSink;
}) {
  const gateway: MutableDiscordGateway | undefined =
    params.gateway ??
    (params.client?.getPlugin<GatewayPlugin>("gateway") as unknown as
      | MutableDiscordGateway
      | undefined);
  if (gateway) {
    registerGateway(params.accountId, gateway);
  }
  const gatewayEmitter = params.gatewaySupervisor.emitter ?? getDiscordGatewayEmitter(gateway);
  const stopGatewayLogging = attachDiscordGatewayLogging({
    emitter: gatewayEmitter,
    runtime: params.runtime,
  });
  let lifecycleStopping = false;

  const pushStatus = (patch: Parameters<DiscordMonitorStatusSink>[0]) => {
    params.statusSink?.(patch);
  };

  const reconnectController = createDiscordGatewayReconnectController({
    accountId: params.accountId,
    gateway,
    runtime: params.runtime,
    abortSignal: params.abortSignal,
    pushStatus,
    isLifecycleStopping: () => lifecycleStopping,
    drainPendingGatewayErrors: () => drainPendingGatewayErrors(),
  });

  gatewayEmitter?.on("debug", reconnectController.onGatewayDebug);

  let sawDisallowedIntents = false;
  const handleGatewayEvent = (event: DiscordGatewayEvent): "continue" | "stop" => {
    if (event.type === "disallowed-intents") {
      sawDisallowedIntents = true;
      params.runtime.error?.(
        danger(
          "discord: gateway closed with code 4014 (missing privileged gateway intents). Enable the required intents in the Discord Developer Portal or disable them in config.",
        ),
      );
      return "stop";
    }
    if (lifecycleStopping && event.type === "reconnect-exhausted") {
      params.runtime.log?.(
        `discord: ignoring expected reconnect-exhausted during shutdown: ${event.message}`,
      );
      return "stop";
    }
    params.runtime.error?.(danger(`discord gateway error: ${event.message}`));
    return event.shouldStopLifecycle ? "stop" : "continue";
  };

  const drainPendingGatewayErrors = (): "continue" | "stop" =>
    params.gatewaySupervisor.drainPending((event) => {
      const decision = handleGatewayEvent(event);
      if (decision !== "stop") return "continue";
      if (
        event.type === "disallowed-intents" ||
        (lifecycleStopping && event.type === "reconnect-exhausted")
      ) {
        return "stop";
      }
      throw event.err;
    });

  try {
    if (params.execApprovalsHandler) {
      await params.execApprovalsHandler.start();
    }

    if (drainPendingGatewayErrors() === "stop") return;

    await reconnectController.ensureStartupReady();

    if (drainPendingGatewayErrors() === "stop") return;

    await waitForDiscordGatewayStop({
      gateway: gateway ? { disconnect: () => gateway.disconnect() } : undefined,
      abortSignal: params.abortSignal,
      gatewaySupervisor: params.gatewaySupervisor,
      onGatewayEvent: handleGatewayEvent,
      registerForceStop: (onForceStop) => {
        reconnectController.registerForceStop((err) => {
          params.gatewaySupervisor.markIntentionalAbort();
          onForceStop(err);
        });
      },
    });
  } catch (err) {
    if (!sawDisallowedIntents && !params.isDisallowedIntentsError(err)) {
      throw err;
    }
  } finally {
    lifecycleStopping = true;
    reconnectController.clearHelloWatch();
    reconnectController.dispose();
    params.gatewaySupervisor.detachLifecycle();
    unregisterGateway(params.accountId);
    stopGatewayLogging();
    gatewayEmitter?.removeListener("debug", reconnectController.onGatewayDebug);
    if (params.voiceManager) {
      await params.voiceManager.destroy();
      params.voiceManagerRef.current = null;
    }
    if (params.execApprovalsHandler) {
      await params.execApprovalsHandler.stop();
    }
    params.threadBindings.stop();
  }
}
