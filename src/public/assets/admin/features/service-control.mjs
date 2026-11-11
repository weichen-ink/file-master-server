import { abortableDelay } from "../api/client.mjs";
import { t } from "../locale.mjs";

/** A successful POST is not proof of restart: wait for a different service start time. */
export async function restartAndReconnect(ctx, signal, { install = false, onProgress = () => {}, wait = abortableDelay } = {}) {
  signal.throwIfAborted();
  const previous = await ctx.api.metrics({ signal });
  signal.throwIfAborted();
  const result = await (install ? ctx.api.install() : ctx.api.restart());
  onProgress([...(result.logs || []), t("reconnecting")].join("\n"));
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(1500, signal);
    signal.throwIfAborted();
    try {
      const current = await ctx.api.metrics({ signal });
      if (current.site.startedAt !== previous.site.startedAt) {
        await ctx.refreshStatus();
        onProgress(t(install ? "updateRestartSuccess" : "serviceRestarted"));
        return;
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
  }
  throw new Error(t("reconnectFailed"));
}
