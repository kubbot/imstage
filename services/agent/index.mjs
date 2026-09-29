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
  IMAGE_PROVIDER_TENCENT_WAND,
  capabilitiesFromConfig,
  resolveAgentConfig,
} from './config.mjs';
import { runAgent } from './run.mjs';
import { createChatProvider, createImageProvider } from './providers.mjs';
import { createTencentImageProvider } from './tencent-images.mjs';

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
export { AGENT_TOOL_SCHEMAS, TOOL_NAMES, INTERNAL_REFERENCE_TOOL_NAMES, INTERNAL_REFERENCE_TOOL_SCHEMAS } from './tools.mjs';
export { runAgent } from './run.mjs';
export { ProviderError, createChatProvider, createImageProvider } from './providers.mjs';
export { createTencentImageProvider } from './tencent-images.mjs';

/**
 * Build the agent runtime from resolved configuration.
 *
 * @param {ReturnType<typeof resolveAgentConfig>} config
 * @param {object} [deps] `chatProvider`, `imageProvider`, `fetchImpl`, `logger`,
 *   `internalReferenceResearch` (offline evaluation only — never settable from
 *   an API/MCP request; enables the retained real-screenshot research tools).
 */
export function createAgentRuntime(config, deps = {}) {
  const internalReferenceResearch = deps.internalReferenceResearch === true;
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
          thinkingEnabled: config.thinkingEnabled,
          fetchImpl,
          maxResponseBytes: config.maxResponseBytes,
        })
      : null);

  const imageProvider =
    deps.imageProvider ??
    (config.imageConfigured
      ? config.imageProvider === IMAGE_PROVIDER_TENCENT_WAND
        ? createTencentImageProvider({
            baseUrl: config.imageBaseUrl,
            apiKey: config.imageApiKey,
            model: config.imageModel,
            fetchImpl,
            maxResponseBytes: config.maxImageResponseBytes,
            maxDownloadBytes: config.maxImageDownloadBytes,
            maxDataUrlChars: AGENT_MAX_ATTACHMENT_CHARS,
            pollIntervalMs: config.imagePollIntervalMs,
            deadlineMs: config.imageDeadlineMs,
          })
        : createImageProvider({
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
      const referenceRequested = Boolean(args.scene && args.scene.reference);
      if (referenceRequested && !internalReferenceResearch) {
        // Real-screenshot reference editing is disabled on all public surfaces.
        // The research implementation is retained for internal offline
        // evaluation only and is unreachable from the API and both MCP servers.
        const error = new Error('真实截图参考编辑已停用：仅支持合成（虚构）对话场景');
        error.code = 'reference_disabled';
        throw error;
      }
      const screenshot = referenceRequested ? await import('./screenshot-tools.mjs') : null;
      if(screenshot) await screenshot.verifyReferenceSources(args.scene.reference,args.signal);
      const toolset = screenshot?.screenshotToolset || null;
      return runAgent({ config, provider: chatProvider, imageProvider, ...args, toolset, internalReferenceResearch });
    },
  };
}
