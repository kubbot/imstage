/**
 * IMStage Agent — public entry point.
 *
 * `createAgentRuntime` wires the configured provider clients and exposes the
 * public capability descriptor plus the `run` entry used by the API server.
 * Tests inject `chatProvider` / `imageProvider` to exercise the loop without
 * any network call.
 */

import {
  AGENT_BODY_LIMIT,
  AGENT_MAX_ATTACHMENT_CHARS,
  capabilitiesFromConfig,
  resolveAgentConfig,
} from './config.mjs';
import { runAgent } from './run.mjs';
import { createChatProvider, createImageProvider } from './providers.mjs';

export { AGENT_BODY_LIMIT, AGENT_MAX_ATTACHMENT_CHARS, resolveAgentConfig, capabilitiesFromConfig };
export { createAgentLimiter } from './limits.mjs';
export { validateAgentInput } from './input.mjs';
export { isBoundedImageDataUrl, detectImageMime } from './media.mjs';
export { buildSceneContext, checkSceneLimits } from './scene-context.mjs';
export {
  ACCEPTED_FINISH_REASONS,
  INCOMPLETE_FINISH_REASONS,
  isAcceptedFinishReason,
  isIncompleteFinishReason,
  finishReasonMessage,
} from './finish.mjs';
export { serializeAgentEvent, AGENT_EVENT_TYPES, AGENT_TOOL_STATES } from './events.mjs';
export { writeNdjsonLine, finishNdjsonResponse, abortedError, isResponseGone } from './stream.mjs';
export { AGENT_TOOL_SCHEMAS, TOOL_NAMES } from './tools.mjs';
export { runAgent } from './run.mjs';
export { ProviderError, createChatProvider, createImageProvider } from './providers.mjs';

/**
 * Build the agent runtime from resolved configuration.
 *
 * @param {ReturnType<typeof resolveAgentConfig>} config
 * @param {object} [deps] `chatProvider`, `imageProvider`, `fetchImpl`, `logger`.
 */
export function createAgentRuntime(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function' && !deps.chatProvider) {
    throw new Error('运行 Agent 需要可用的 fetch');
  }

  const chatProvider =
    deps.chatProvider ??
    (config.configured
      ? createChatProvider({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          fetchImpl,
          maxResponseBytes: config.maxResponseBytes,
        })
      : null);

  const imageProvider =
    deps.imageProvider ??
    (config.imageConfigured
      ? createImageProvider({
          baseUrl: config.imageBaseUrl,
          apiKey: config.imageApiKey,
          model: config.imageModel,
          fetchImpl,
          maxResponseBytes: config.maxImageResponseBytes,
          maxDataUrlChars: AGENT_MAX_ATTACHMENT_CHARS,
        })
      : null);

  return {
    capabilities: capabilitiesFromConfig(config, Boolean(chatProvider), Boolean(imageProvider)),
    async run(args) {
      if (!chatProvider) {
        const error = new Error('AI 服务尚未配置，无法运行 Agent');
        error.code = 'ai_not_configured';
        throw error;
      }
      const screenshot = args.scene.reference ? await import('./screenshot-tools.mjs') : null;
      if(screenshot) await screenshot.verifyReferenceSources(args.scene.reference,args.signal);
      const toolset = screenshot?.screenshotToolset || null;
      return runAgent({ config, provider: chatProvider, imageProvider, ...args, toolset });
    },
  };
}
