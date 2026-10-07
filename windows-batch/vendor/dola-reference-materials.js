(() => {
  'use strict';

  if (window.__WANWAN_DOLA_REFERENCE_MATERIALS_V1__) return;
  window.__WANWAN_DOLA_REFERENCE_MATERIALS_V1__ = true;

  const host = (() => {
    try { return location.hostname.replace(/^www\./i, '').toLowerCase(); }
    catch (_) { return ''; }
  })();
  if (!(host === 'dola.com' || host.endsWith('.dola.com'))) return;

  const PANEL_ID = 'wanwan-material-upload-panel';
  const STYLE_ID = 'wanwan-material-upload-style';
  const DOLA_VIDEO_UPLOAD_MODULE_ID = 784675;
  const DOLA_VIDEO_SKILL_TYPE = 17;
  const DOLA_ATTACHMENT_BLOCK_TYPE = 10052;
  const MATERIAL_LIMITS = { image: 30, video: 10, audio: 10 };
  const SEEDANCE_MEDIA_ACCEPT = '.jpg,.png,.jpeg,.webp,.apng,.mp4,.mov,video/mp4,video/quicktime,.mp3,.wav,audio/mpeg,audio/wav';
  const SEEDANCE_IMAGE_ACCEPT = '.jpg,.png,.jpeg,.webp,.apng,image/jpeg,image/png,image/webp,image/apng';
  const materials = [];
  let materialDragId = '';
  let dolaWebpackRequire = null;
  let dolaSubmitPatchPending = false;
  let dolaLastReferenceChatId = '';
  let dolaConfiguredUploadPipeline = null;
  let dolaConfiguredUploadPipelineModuleId = null;
  let dolaStoreApi = null;

  const json = (text, fallback) => { try { return JSON.parse(text); } catch (_) { return fallback; } };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const html = value => String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  function materialKind(file) {
    const type = String(file?.type || '').toLowerCase();
    const name = String(file?.name || '').toLowerCase();
    if (type.startsWith('image/') || /\.(jpe?g|png|webp|apng)$/.test(name)) return 'image';
    if (type.startsWith('video/') || /\.(mp4|mov)$/.test(name)) return 'video';
    if (type.startsWith('audio/') || /\.(mp3|wav)$/.test(name)) return 'audio';
    return '';
  }

  function materialCounts(items = materials) {
    const counts = { image: 0, video: 0, audio: 0 };
    for (const item of items) {
      const kind = item.kind || materialKind(item.file);
      if (kind && Object.prototype.hasOwnProperty.call(counts, kind)) counts[kind] += 1;
    }
    return counts;
  }

  function selectedModelText() {
    const control = document.querySelector?.('[data-input-engine-actionbar-control-key="video-model"], [data-input-engine-actionbar-control-key="model"]');
    return String(control?.textContent || control?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
  }

  function isSeedance25Selected() {
    return /2\.5|seedance[^\d]*2[^\d]*5/i.test(selectedModelText());
  }

  function isSeedance20FastSelected() {
    return /2\.0|seedance[^\d]*2[^\d]*0|fast|快速/i.test(selectedModelText());
  }

  // 仅图片素材时 2.0 Fast 与 2.5 都可用；视频/音频仍然只支持 2.5。
  function isImageUploadModelSelected() {
    return isSeedance25Selected() || isSeedance20FastSelected();
  }

  // 国际豆包原实现中的关键兼容层：Dola 有时会把视频/音频 VOD 上传域名
  // 拼到当前 /chat/ 地址后面。图片走的是另一条上传链路，因此通常只有媒体失败。
  function normalizeDolaUploadUrl(raw) {
    const value = String(raw || '');
    const match = value.match(/^(?:https?:\/\/www\.dola\.com\/chat\/)?(vod-[a-z0-9.-]+\.bytevcloudapi\.com)(\/?\?.*)$/i);
    return match ? `https://${match[1]}${match[2]}` : value;
  }

  function patchDolaMediaUploadRequests() {
    if (window.__WANWAN_DOLA_MEDIA_UPLOAD_URL_PATCH__) return;
    window.__WANWAN_DOLA_MEDIA_UPLOAD_URL_PATCH__ = true;
    const oldFetch = window.fetch;
    if (typeof oldFetch === 'function') {
      window.fetch = function patchedMediaFetch(input, init = {}) {
        const originalUrl = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input || '');
        const requestUrl = normalizeDolaUploadUrl(originalUrl);
        if (requestUrl !== originalUrl) {
          try {
            input = typeof input === 'object' && input instanceof Request ? new Request(requestUrl, input) : requestUrl;
          } catch (_) {
            input = requestUrl;
          }
        }
        return oldFetch.call(this, input, init);
      };
    }
    const oldOpen = XMLHttpRequest.prototype.open;
    if (typeof oldOpen === 'function') {
      XMLHttpRequest.prototype.open = function patchedMediaOpen(method, url) {
        const args = Array.from(arguments);
        args[1] = normalizeDolaUploadUrl(url);
        return oldOpen.apply(this, args);
      };
    }
  }

  function getDolaWebpackRequire() {
    if (dolaWebpackRequire) return dolaWebpackRequire;
    const chunks = window.__LOADABLE_LOADED_CHUNKS__;
    if (!Array.isArray(chunks)) return null;
    try {
      chunks.push([[`wanwan-media-${Date.now()}`], {}, runtime => { dolaWebpackRequire = runtime; }]);
    } catch (_) {}
    return dolaWebpackRequire;
  }

  const DOLA_STORE_MODULE_IDS = [498760, 16889];

  function getDolaStoreApi(runtime) {
    if (dolaStoreApi && typeof dolaStoreApi.GX === 'function') return dolaStoreApi;
    for (const moduleId of DOLA_STORE_MODULE_IDS) {
      try {
        const candidate = runtime(moduleId);
        if (candidate && typeof candidate.GX === 'function') {
          dolaStoreApi = candidate;
          return candidate;
        }
      } catch (_) {}
    }
    return null;
  }

  function dolaReferenceSnapshot(runtime, preferredChatId = '') {
    try {
      const storeApi = getDolaStoreApi(runtime);
      const attachmentsStore = storeApi?.GX?.('attachmentsStore');
      const uploadStore = storeApi?.GX?.('attachmentUploadStore');
      const attachmentsMap = attachmentsStore?.attachmentsMap || {};
      const taskMap = uploadStore?.preprocessTaskMap || {};
      const currentChatId = storeApi?.GX?.('chatViewCoreStore')?.currentChatViewConfig?.chatId || '';
      const chatIds = Array.from(new Set([currentChatId, preferredChatId].filter(Boolean)));
      if (dolaLastReferenceChatId && chatIds.includes(dolaLastReferenceChatId)) chatIds.unshift(dolaLastReferenceChatId);
      let selected = { chatId: preferredChatId || currentChatId, attachments: [] };
      for (const chatId of chatIds) {
        const attachments = attachmentsMap?.[chatId]?.[`_${DOLA_VIDEO_SKILL_TYPE}`] || [];
        if (attachments.length) {
          selected = { chatId, attachments };
          break;
        }
      }
      const attachmentKeys = [];
      const attachmentStates = [];
      const counts = { image: 0, video: 0, audio: 0 };
      let pendingMedia = 0;
      for (const attachment of selected.attachments) {
        const kind = attachment?.type;
        if (Object.prototype.hasOwnProperty.call(counts, kind)) counts[kind] += 1;
        const localKey = attachment?.localKey || '';
        const task = localKey ? taskMap[localKey] : null;
        const uploadResult = task?.uploadResult || {};
        const videoMeta = uploadResult.VideoMeta || {};
        const extra = task?.ctx?.extraParams || {};
        const key = dolaAttachmentKey(attachment, task);
        if (['video', 'audio'].includes(kind) && (!key || dolaUploadTaskPending(task) || dolaUploadTaskFailed(task))) pendingMedia += 1;
        attachmentKeys.push(key || undefined);
        attachmentStates.push({
          type: kind,
          localKey,
          fileKey: key || undefined,
          fileName: attachment?.fileName || attachment?.file?.name || videoMeta.FileName || '',
          size: Number(attachment?.size || attachment?.file?.size || videoMeta.Size || 0),
          md5: attachment?.md5 || task?.md5 || videoMeta.Md5,
          mediaDuration: Number(attachment?.mediaDuration || videoMeta.Duration || extra.duration_seconds || 0),
          mediaResourceUri: attachment?.mediaResourceUri || task?.mediaResourceUri,
          mediaCoverUrl: attachment?.mediaCoverUrl || extra.cover_local_url || task?.blobUrl || '',
          mediaCoverWidth: Number(attachment?.mediaCoverWidth || extra.cover_width || videoMeta.Width || 0),
          mediaCoverHeight: Number(attachment?.mediaCoverHeight || extra.cover_height || videoMeta.Height || 0),
          imageWidth: Number(attachment?.imageWidth || uploadResult.ImageWidth || 0),
          imageHeight: Number(attachment?.imageHeight || uploadResult.ImageHeight || 0),
          url: attachment?.url || task?.blobUrl || '',
          src: attachment?.src || task?.blobUrl || '',
          uploadPercent: Number.isFinite(Number(task?.percent)) ? Number(task.percent) : 100,
          status: dolaUploadTaskFailed(task) ? 'Retry' : dolaUploadTaskPending(task) ? 'Uploading' : 'Normal'
        });
      }
      return { ...selected, attachmentKeys, attachmentStates, counts, pendingMedia, taskMap };
    } catch (_) {
      return { chatId: preferredChatId, attachments: [], attachmentKeys: [], attachmentStates: [], counts: { image: 0, video: 0, audio: 0 }, pendingMedia: 0, taskMap: {} };
    }
  }

  function attachmentBlockCounts(block) {
    const counts = { image: 0, video: 0, audio: 0 };
    const attachments = block?.content?.attachment_block?.attachments || [];
    for (const item of attachments) {
      if (item?.type === 1) counts.image += 1;
      if (item?.type === 2 && item?.media?.media_type === 2) counts.video += 1;
      if (item?.type === 2 && item?.media?.media_type === 1) counts.audio += 1;
    }
    return counts;
  }

  function isDolaVideoMessage(message) {
    const ability = json(message?.ext?.chat_ability, {});
    return Number(ability?.ability_type) === DOLA_VIDEO_SKILL_TYPE;
  }

  function ensureDolaMediaReferences(runtime, request) {
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const videoMessageIndex = messages.findIndex(isDolaVideoMessage);
    if (videoMessageIndex < 0) return request;
    const preferredChatId = messages[videoMessageIndex]?.conversation_id || '';
    const snapshot = dolaReferenceSnapshot(runtime, preferredChatId);
    const expectedMedia = snapshot.counts.video + snapshot.counts.audio;
    if (!expectedMedia) return request;
    const buildAttachmentBlock = runtime(597338)?.S;
    const block = typeof buildAttachmentBlock === 'function' ? buildAttachmentBlock({
      attachments: snapshot.attachments,
      attachmentKeys: snapshot.attachmentKeys,
      attachmentStates: snapshot.attachmentStates
    }) : null;
    const submitted = attachmentBlockCounts(block);
    const submittedMedia = submitted.video + submitted.audio;
    if (!block || snapshot.pendingMedia || submittedMedia < expectedMedia) {
      status(`参考素材尚未全部进入生成请求：视频 ${submitted.video}/${snapshot.counts.video}，音频 ${submitted.audio}/${snapshot.counts.audio}，已阻止本次提交`, 'warn');
      throw new Error('Seedance 参考音频/视频仍在上传或未完成绑定，请等待后重试');
    }
    const clonedMessages = messages.map(message => ({ ...message, content_blocks_v2: [...(message.content_blocks_v2 || [])] }));
    let targetIndex = clonedMessages.findIndex(message => message.content_blocks_v2.some(item => item?.block_type === DOLA_ATTACHMENT_BLOCK_TYPE));
    if (targetIndex < 0) targetIndex = videoMessageIndex;
    const blocks = clonedMessages[targetIndex].content_blocks_v2;
    const blockIndex = blocks.findIndex(item => item?.block_type === DOLA_ATTACHMENT_BLOCK_TYPE);
    if (blockIndex >= 0) blocks[blockIndex] = block;
    else blocks.unshift(block);
    return { ...request, messages: clonedMessages };
  }

  async function patchDolaVideoSubmit() {
    if (dolaSubmitPatchPending) return false;
    const runtime = getDolaWebpackRequire();
    if (typeof runtime !== 'function') return false;
    if (runtime.m && !runtime.m[431565]) return false;
    dolaSubmitPatchPending = true;
    try {
      const chatIMService = await runtime(431565)?.D?.('chatIMService');
      const messageService = await chatIMService?.getMessageService?.();
      if (!messageService || typeof messageService.sendMessage !== 'function') return false;
      if (messageService.sendMessage.__INTL_DOUBAO_MEDIA_REFERENCES_PATCHED__) return true;
      const originalSendMessage = messageService.sendMessage;
      const patchedSendMessage = function (request, ...args) {
        return originalSendMessage.call(this, ensureDolaMediaReferences(runtime, request), ...args);
      };
      patchedSendMessage.__INTL_DOUBAO_MEDIA_REFERENCES_PATCHED__ = true;
      messageService.sendMessage = patchedSendMessage;
      return true;
    } catch (_) {
      return false;
    } finally {
      dolaSubmitPatchPending = false;
    }
  }

  function patchDolaVideoUploadConfig(config) {
    if (!config || typeof config !== 'object') return false;
    config.acceptedAttachmentTypes = ['image', 'video', 'audio'];
    config.acceptedFileExtensions = ['jpg', 'jpeg', 'png', 'webp', 'apng', 'mp4', 'mov', 'mp3', 'wav'];
    config.maxCount = MATERIAL_LIMITS.image + MATERIAL_LIMITS.video + MATERIAL_LIMITS.audio;
    config.addAttachmentType = ({ file } = {}) => materialKind(file) || 'file';
    config.isReusableAttachment = attachment => ['image', 'video', 'audio'].includes(attachment?.type);
    return true;
  }

  function wrapDolaVideoUploadFactory(modules) {
    const factory = modules?.[DOLA_VIDEO_UPLOAD_MODULE_ID];
    if (typeof factory !== 'function' || factory.__INTL_DOUBAO_MEDIA_PATCHED__) return false;
    const wrapped = function (...args) {
      const result = factory.apply(this, args);
      try { patchDolaVideoUploadConfig(args[1]?.videoUploadPipelineConfig); } catch (_) {}
      return result;
    };
    wrapped.__INTL_DOUBAO_MEDIA_PATCHED__ = true;
    modules[DOLA_VIDEO_UPLOAD_MODULE_ID] = wrapped;
    return true;
  }

  function hookDolaVideoUploadChunk() {
    const chunks = window.__LOADABLE_LOADED_CHUNKS__;
    if (!Array.isArray(chunks)) return false;
    if (!chunks.push?.__INTL_DOUBAO_MEDIA_PUSH_WRAPPED__) {
      const originalPush = chunks.push;
      const patchedPush = function (...entries) {
        for (const entry of entries) wrapDolaVideoUploadFactory(entry?.[1]);
        return originalPush.apply(this, entries);
      };
      patchedPush.__INTL_DOUBAO_MEDIA_PUSH_WRAPPED__ = true;
      chunks.push = patchedPush;
      chunks.__INTL_DOUBAO_MEDIA_PUSH_PATCHED__ = true;
    }
    try {
      const runtime = getDolaWebpackRequire();
      wrapDolaVideoUploadFactory(runtime?.m);
    } catch (_) {}
    return true;
  }

  function watchDolaVideoUploadChunks() {
    const property = '__LOADABLE_LOADED_CHUNKS__';
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, property);
      if (descriptor?.set?.__WANWAN_DOLA_CHUNK_WATCHER__) return true;
      if (descriptor && !descriptor.configurable) {
        hookDolaVideoUploadChunk();
        return false;
      }
      let value = window[property];
      const setter = function (next) {
        value = next;
        if (Array.isArray(value)) hookDolaVideoUploadChunk();
      };
      setter.__WANWAN_DOLA_CHUNK_WATCHER__ = true;
      Object.defineProperty(window, property, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set: setter
      });
      if (Array.isArray(value)) hookDolaVideoUploadChunk();
      return true;
    } catch (_) {
      return false;
    }
  }

  function enhanceSeedanceMediaSupport() {
    if (!isImageUploadModelSelected()) return false;
    let patched = false;
    try {
      const runtime = getDolaWebpackRequire();
      wrapDolaVideoUploadFactory(runtime?.m);
      const config = runtime?.m?.[DOLA_VIDEO_UPLOAD_MODULE_ID] ? runtime(DOLA_VIDEO_UPLOAD_MODULE_ID)?.videoUploadPipelineConfig : null;
      if (patchDolaVideoUploadConfig(config)) patched = true;
    } catch (_) {}
    try {
      for (const input of Array.from(document.querySelectorAll?.('input[type="file"]') || [])) {
        if (input.closest?.(`#${PANEL_ID}`)) continue;
        const accept = String(input.accept || input.getAttribute?.('accept') || '');
        if (!/jpe?g|png|webp|image/i.test(accept)) continue;
        input.setAttribute('accept', isSeedance25Selected() ? SEEDANCE_MEDIA_ACCEPT : SEEDANCE_IMAGE_ACCEPT);
        input.multiple = true;
        patched = true;
      }
    } catch (_) {}
    return patched;
  }

  function findDolaInputProps() {
    const input = Array.from(document.querySelectorAll?.('input[type="file"]') || [])
      .find(node => !node.closest?.(`#${PANEL_ID}`));
    if (!input) return null;
    const key = Object.keys(input).find(name => name.startsWith('__reactFiber$'));
    let fiber = key ? input[key] : null;
    for (let i = 0; fiber && i < 8; i += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || {};
      if (props.chatId && props.skill && props.inputUploadConfig) return props;
    }
    return null;
  }

  function dolaBotId(runtime, chatId) {
    try {
      return runtime(372595)?.S?.(chatId, true)
        || runtime(29155)?.IO?.(runtime(986344)?.NW?.getState?.())
        || '';
    } catch (_) { return ''; }
  }

  function readMediaDuration(file, kind) {
    return new Promise(resolve => {
      if (!['video', 'audio'].includes(kind)) return resolve({ duration: 0, unreadable: false });
      const url = URL.createObjectURL(file);
      const media = document.createElement(kind);
      let settled = false;
      const finish = duration => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        const value = Number.isFinite(duration) && duration > 0 ? duration : 0;
        resolve({ duration: value, unreadable: !value });
      };
      const timer = window.setTimeout(() => finish(0), 3500);
      media.preload = 'metadata';
      media.onloadedmetadata = () => { window.clearTimeout(timer); finish(media.duration); };
      media.onerror = () => { window.clearTimeout(timer); finish(0); };
      media.src = url;
    });
  }

  async function initDolaMediaUploader(runtime, kind) {
    if (!['video', 'audio'].includes(kind)) return;
    const service = await runtime(431565)?.D?.('attachmentUploadStoreService');
    const mediaConfig = runtime(607159);
    const base = mediaConfig?.tV;
    const scene = kind === 'audio' ? mediaConfig?.Ew : mediaConfig?.eq;
    if (!service?.initUploader || !base || !scene) return;
    await service.initUploader({
      mediaUploaderOptions: {
        ...base,
        scene,
        resourcePrepareUploadParams: {
          ...(base.resourcePrepareUploadParams || {}),
          scene_id: scene
        }
      }
    });
  }

  function buildDolaVideoAttachmentCtx({ file, skill, uploadCollectionId, chatId, runtime, mediaMeta }) {
    const skillType = Number(skill?.skill_type || 17);
    const duration = Number(mediaMeta?.duration || 0);
    return {
      conversationId: chatId || '',
      chatType: 'other_default',
      skillType,
      skillId: String(skillType),
      botId: dolaBotId(runtime, chatId),
      from: '',
      uploadCollectionWay: 'single',
      uploadId: '',
      uploadWay: 'browse_folder',
      uploadFrom: 'video_generation',
      uploadCollectionId,
      uploadType: String(file?.type || ''),
      extraParams: {
        ...(duration > 0 ? { duration_seconds: String(duration) } : {}),
        ...(mediaMeta?.unreadable ? { duration_unreadable: '1' } : {})
      }
    };
  }

  function dolaAttachmentKey(attachment, task) {
    const uploadResult = task?.uploadResult || {};
    return attachment?.key
      || attachment?.fileKey
      || attachment?.resourceKey
      || attachment?.mediaKey
      || task?.key
      || task?.fileKey
      || task?.resourceKey
      || uploadResult?.key
      || uploadResult?.Key
      || uploadResult?.fileKey
      || uploadResult?.FileKey
      || uploadResult?.resourceKey
      || uploadResult?.ResourceKey
      || '';
  }

  function dolaUploadTaskFailed(task) {
    const state = String(task?.status || task?.state || task?.uploadStatus || '').toLowerCase();
    return task?.failed === true || /fail|error|cancel/.test(state);
  }

  function dolaUploadTaskPending(task) {
    const state = String(task?.status || task?.state || task?.uploadStatus || '').toLowerCase();
    if (dolaUploadTaskFailed(task)) return false;
    if (task?.loading === true) return true;
    return /pending|uploading|processing|preprocess|running|waiting/.test(state);
  }

  function findNewDolaAttachment(attachments, beforeLocalKeys, file, kind) {
    const candidates = Array.from(attachments || []).filter(item => {
      const localKey = item?.localKey || '';
      if (localKey && beforeLocalKeys.has(localKey)) return false;
      return !kind || item?.type === kind;
    });
    if (!candidates.length) return null;
    const exactName = candidates.find(item => (item?.fileName || item?.file?.name || '') === file?.name);
    if (exactName) return exactName;
    const expectedSize = Number(file?.size || 0);
    if (expectedSize > 0) {
      const sameSize = candidates.find(item => Number(item?.size || item?.file?.size || 0) === expectedSize);
      if (sameSize) return sameSize;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function waitForDolaReferenceUpload(runtime, chatId, beforeLocalKeys, file, timeoutMs = 120000) {
    const kind = materialKind(file);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const storeApi = getDolaStoreApi(runtime);
      const attachmentsStore = storeApi?.GX?.('attachmentsStore');
      const uploadStore = storeApi?.GX?.('attachmentUploadStore');
      const attachments = attachmentsStore?.attachmentsMap?.[chatId]?.[`_${DOLA_VIDEO_SKILL_TYPE}`] || [];
      const attachment = findNewDolaAttachment(attachments, beforeLocalKeys, file, kind);
      if (attachment) {
        const task = uploadStore?.preprocessTaskMap?.[attachment.localKey];
        if (dolaUploadTaskFailed(task)) {
          const detail = task?.error?.message || task?.errorMessage || task?.message || task?.uploadResult?.ErrorMessage || '';
          throw new Error(`${file.name} 上传失败${detail ? `：${detail}` : ''}`);
        }
        const key = dolaAttachmentKey(attachment, task);
        if (key && !dolaUploadTaskPending(task)) return attachment;
      }
      await wait(300);
    }
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    throw new Error(`${file.name} 未在 ${seconds} 秒内完成上传绑定`);
  }

  const DOLA_UPLOAD_PIPELINE_HINTS = [
    /inputUploadConfig/i,
    /uploadPipelineConfig/i,
    /attachmentChannel/i,
    /targetAttachmentChannel/i,
    /uploadCollectionId/i,
    /buildAttachmentCtx/i,
    /trigger/i,
    /files/i
  ];

  function dolaPipelineFunctionScore(fn, origin = '') {
    if (typeof fn !== 'function') return -1;
    let source = '';
    try { source = Function.prototype.toString.call(fn); } catch (_) {}
    const label = String(origin || '');
    let score = /upload.*pipeline|pipeline.*upload/i.test(label) ? 12 : 0;
    for (const hint of DOLA_UPLOAD_PIPELINE_HINTS) {
      if (hint.test(source)) score += 3;
    }
    if (/inputUploadConfig|uploadPipelineConfig/i.test(source)) score += 4;
    if (/attachmentChannel|targetAttachmentChannel/i.test(source)) score += 4;
    return score;
  }

  function dolaPipelineCandidates(value, origin, explicit = false, depth = 0, seen = new Set()) {
    const candidates = [];
    if (value == null || depth > 2) return candidates;
    const valueType = typeof value;
    if (valueType === 'function') {
      candidates.push({ fn: value, origin, score: explicit ? 100 : dolaPipelineFunctionScore(value, origin) });
      return candidates;
    }
    if (valueType !== 'object' || seen.has(value)) return candidates;
    seen.add(value);
    let descriptors = {};
    try { descriptors = Object.getOwnPropertyDescriptors(value); } catch (_) { return candidates; }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const childOrigin = origin ? origin + '.' + key : key;
      const namedPipeline = /^(?:Z|default|runConfiguredUploadPipeline|runUploadPipeline|uploadPipeline|configuredUploadPipeline)$/i.test(key)
        || /upload.*pipeline|pipeline.*upload/i.test(key);
      let child;
      if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        child = descriptor.value;
      } else if (namedPipeline && typeof descriptor.get === 'function') {
        try { child = descriptor.get.call(value); } catch (_) { continue; }
      } else {
        continue;
      }
      if (typeof child === 'function') {
        candidates.push({ fn: child, origin: childOrigin, score: namedPipeline ? 100 : dolaPipelineFunctionScore(child, childOrigin) });
      } else if (child && typeof child === 'object' && depth < 2) {
        candidates.push(...dolaPipelineCandidates(child, childOrigin, explicit || namedPipeline, depth + 1, seen));
      }
    }
    return candidates;
  }

  function bestDolaPipelineCandidate(candidates, minimumScore = 12) {
    const best = candidates
      .filter(candidate => typeof candidate?.fn === 'function')
      .sort((left, right) => right.score - left.score)[0];
    return best && best.score >= minimumScore ? best.fn : null;
  }

  const DOLA_UPLOAD_PIPELINE_MODULE_IDS = [230565, 998058];
  const DOLA_UPLOAD_FACTORY_REQUIRED_HINTS = [
    /inputUploadConfig/,
    /uploadPipelineConfig/,
    /attachmentChannel/,
    /targetAttachmentChannel/,
    /files/,
    /trigger/
  ];

  function dolaUploadFactoryScore(factory) {
    if (typeof factory !== 'function') return -1;
    let source = '';
    try { source = Function.prototype.toString.call(factory); } catch (_) { return -1; }
    if (!DOLA_UPLOAD_FACTORY_REQUIRED_HINTS.every(hint => hint.test(source))) return -1;
    let score = DOLA_UPLOAD_FACTORY_REQUIRED_HINTS.length * 10;
    if (/sourceAttachmentChannel/.test(source)) score += 3;
    if (/buildAttachmentCtx/.test(source)) score += 3;
    if (/uploadCollectionId/.test(source)) score += 3;
    return score;
  }

  function resolveDolaPipelineModule(runtime, moduleId, origin) {
    try {
      const exportsValue = runtime(moduleId);
      const resolved = bestDolaPipelineCandidate(dolaPipelineCandidates(exportsValue, origin, true), 12);
      if (!resolved) return null;
      dolaConfiguredUploadPipelineModuleId = moduleId;
      return resolved;
    } catch (_) {
      return null;
    }
  }

  function findDolaUploadPipeline(runtime, props, inputUploadConfig, pipelineConfig) {
    if (typeof dolaConfiguredUploadPipeline === 'function') return dolaConfiguredUploadPipeline;

    const preferredModuleIds = [
      dolaConfiguredUploadPipelineModuleId,
      ...DOLA_UPLOAD_PIPELINE_MODULE_IDS
    ].filter((moduleId, index, values) => moduleId != null && values.indexOf(moduleId) === index);
    for (const moduleId of preferredModuleIds) {
      const resolved = resolveDolaPipelineModule(runtime, moduleId, 'runtime.' + moduleId);
      if (resolved) return (dolaConfiguredUploadPipeline = resolved);
    }

    const directCandidates = [];
    directCandidates.push(...dolaPipelineCandidates(inputUploadConfig, 'inputUploadConfig'));
    directCandidates.push(...dolaPipelineCandidates(pipelineConfig, 'pipelineConfig'));
    directCandidates.push(...dolaPipelineCandidates(props, 'inputProps'));
    let resolved = bestDolaPipelineCandidate(directCandidates, 12);
    if (resolved) return (dolaConfiguredUploadPipeline = resolved);

    const loadedCandidates = [];
    const moduleCache = runtime.c && typeof runtime.c === 'object' ? runtime.c : {};
    for (const [moduleId, moduleRecord] of Object.entries(moduleCache)) {
      const exportsValue = moduleRecord?.exports ?? moduleRecord;
      loadedCandidates.push(...dolaPipelineCandidates(exportsValue, 'runtime.c.' + moduleId));
    }
    resolved = bestDolaPipelineCandidate(loadedCandidates, 16);
    if (resolved) return (dolaConfiguredUploadPipeline = resolved);

    const moduleFactories = runtime.m && typeof runtime.m === 'object' ? runtime.m : {};
    const factoryCandidates = Object.entries(moduleFactories)
      .map(([moduleId, factory]) => ({ moduleId, score: dolaUploadFactoryScore(factory) }))
      .filter(candidate => candidate.score >= 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3);
    for (const candidate of factoryCandidates) {
      resolved = resolveDolaPipelineModule(runtime, candidate.moduleId, 'runtime.m.' + candidate.moduleId);
      if (resolved) return (dolaConfiguredUploadPipeline = resolved);
    }
    return null;
  }

  function isTransientDolaUploadError(error) {
    const message = String(error?.message || error || '');
    return /reading ['"]call['"]|undefined.*call|chunk|module.*(?:not|尚未).*load|loading/i.test(message);
  }

  async function runDolaUploadPipelineWithRetry(resolvePipeline, args, hasNewAttachment, attempts = 4, retryDelayMs = 450) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const pipeline = resolvePipeline?.();
      if (typeof pipeline !== 'function') {
        lastError = new Error('Dola 上传管线模块尚未加载');
      } else {
        try {
          return await pipeline(args);
        } catch (error) {
          if (hasNewAttachment?.()) return;
          lastError = error;
          if (!isTransientDolaUploadError(error)) throw error;
        }
      }
      if (attempt < attempts) {
        dolaConfiguredUploadPipeline = null;
        hookDolaVideoUploadChunk();
        await wait(retryDelayMs);
      }
    }
    throw lastError || new Error('Dola 上传管线模块尚未加载');
  }

  async function waitForDolaUploadContext(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let sawProps = false;
    let sawConfig = false;
    while (Date.now() < deadline) {
      const props = findDolaInputProps();
      sawProps = sawProps || !!props;
      const runtime = getDolaWebpackRequire();
      if (props && typeof runtime === 'function') {
        const inputUploadConfig = props.inputUploadConfig || {};
        let pipelineConfig = null;
        try { pipelineConfig = await inputUploadConfig.uploadPipelineConfig?.(); } catch (_) {}
        sawConfig = sawConfig || !!pipelineConfig;
        if (pipelineConfig && typeof pipelineConfig === 'object') {
          patchDolaVideoUploadConfig(pipelineConfig);
          const pipeline = findDolaUploadPipeline(runtime, props, inputUploadConfig, pipelineConfig);
          if (typeof pipeline === 'function') return { props, runtime, inputUploadConfig, pipelineConfig };
        }
      }
      hookDolaVideoUploadChunk();
      await wait(250);
    }
    if (!sawProps) return { ok: false, reason: '未找到视频创作上传上下文，请等待页面加载完成' };
    if (!sawConfig) return { ok: false, reason: 'Dola 视频上传配置尚未加载，请稍后重试' };
    return { ok: false, reason: 'Dola 上传管线模块未加载或页面签名已变化，请刷新页面后重试' };
  }

  async function addMaterialsToDolaReferenceStore(files) {
    const initialProps = findDolaInputProps();
    const requestedCounts = materialCounts(files.map(file => ({ file })));
    const needsMediaModel = requestedCounts.video > 0 || requestedCounts.audio > 0;
    const modelReady = () => isSeedance25Selected() || (!needsMediaModel && isSeedance20FastSelected());
    if (needsMediaModel && !isSeedance25Selected()) {
      return { ok: false, reason: '视频,音频 素材仅支持2.5模型，请先更换模型' };
    }
    if (initialProps && (Number(initialProps.skill?.skill_type) !== 17 || !modelReady())) {
      return { ok: false, reason: '请先在 AI 创作中切换到视频和 Seedance 2.5 / 2.0 Fast' };
    }
    const context = await waitForDolaUploadContext();
    if (context?.ok === false) return context;
    const { props, runtime, inputUploadConfig, pipelineConfig } = context;
    if (Number(props.skill?.skill_type) !== 17 || !modelReady()) {
      return { ok: false, reason: '请先在 AI 创作中切换到视频和 Seedance 2.5 / 2.0 Fast' };
    }
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      status(`正在移入 ${index + 1}/${files.length}：${file.name}`, '');
      const getAttachments = () => getDolaStoreApi(runtime)?.GX?.('attachmentsStore')?.attachmentsMap?.[props.chatId]?.[`_${DOLA_VIDEO_SKILL_TYPE}`] || [];
      const existing = getAttachments();
      const beforeLocalKeys = new Set(existing.map(item => item?.localKey).filter(Boolean));
      const kind = materialKind(file);
      let initError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await initDolaMediaUploader(runtime, kind);
          initError = null;
          break;
        } catch (error) {
          initError = error;
          if (!isTransientDolaUploadError(error) || attempt === 2) break;
          await wait(400);
        }
      }
      if (initError) throw initError;
      const mediaMeta = await readMediaDuration(file, kind);
      const uploadPipelineConfig = {
        ...pipelineConfig,
        buildAttachmentCtx: ({ file: currentFile, skill, uploadCollectionId }) => buildDolaVideoAttachmentCtx({
          file: currentFile,
          skill,
          uploadCollectionId,
          chatId: props.chatId,
          runtime,
          mediaMeta
        })
      };
      const args = {
        inputUploadConfig,
        trigger: 'click',
        chatId: props.chatId,
        chatType: props.chatType,
        skill: props.skill,
        reportParams: props.reportParams,
        files: [file],
        inputConfigKey: props.inputConfigKey,
        attachmentChannel: DOLA_VIDEO_SKILL_TYPE,
        targetAttachmentChannel: DOLA_VIDEO_SKILL_TYPE,
        uploadPipelineConfig
      };
      await runDolaUploadPipelineWithRetry(
        () => findDolaUploadPipeline(runtime, props, inputUploadConfig, pipelineConfig),
        args,
        () => !!findNewDolaAttachment(getAttachments(), beforeLocalKeys, file, kind)
      );
      await waitForDolaReferenceUpload(runtime, props.chatId, beforeLocalKeys, file);
    }
    dolaLastReferenceChatId = props.chatId;
    return { ok: true, counts: dolaReferenceSnapshot(runtime, props.chatId).counts };
  }

  function status(message, type = '') {
    const el = document.querySelector(`#${PANEL_ID} .wanwan-material-status`);
    if (!el) return;
    el.textContent = message || '';
    el.dataset.type = type;
  }

  function reorderMaterial(fromId, toIndex) {
    const from = materials.findIndex(candidate => candidate.id === fromId);
    if (from < 0 || toIndex < 0 || toIndex >= materials.length || from === toIndex) return false;
    const [moved] = materials.splice(from, 1);
    materials.splice(toIndex, 0, moved);
    renderMaterials();
    status('已调整素材顺序，将按此顺序移入生成框', 'ok');
    return true;
  }

  function renderMaterials() {
    const list = document.querySelector(`#${PANEL_ID} .wanwan-material-list`);
    const count = document.querySelector(`#${PANEL_ID} .wanwan-material-count`);
    if (!list || !count) return;
    const counts = materialCounts();
    count.textContent = `图片 ${counts.image}/${MATERIAL_LIMITS.image} · 视频 ${counts.video}/${MATERIAL_LIMITS.video} · 音频 ${counts.audio}/${MATERIAL_LIMITS.audio}`;
    list.innerHTML = '';
    if (!materials.length) {
      list.innerHTML = '<div class="wanwan-material-empty">暂无素材</div>';
      return;
    }
    const clearDropMarkers = () => {
      for (const row of list.querySelectorAll('.wanwan-material-item.drop-target')) row.classList.remove('drop-target');
    };
    for (const item of materials) {
      const row = document.createElement('div');
      row.className = 'wanwan-material-item';
      row.draggable = true;
      row.innerHTML = `<span class="wanwan-material-grip" title="拖动调整顺序">⋮</span><span title="${html(item.file.name)}">${html(item.file.name)}</span><button type="button" title="移除">×</button>`;
      row.addEventListener('dragstart', event => {
        materialDragId = item.id;
        row.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          try { event.dataTransfer.setData('text/plain', item.id); } catch (_) {}
        }
      });
      row.addEventListener('dragend', () => {
        materialDragId = '';
        row.classList.remove('dragging');
        clearDropMarkers();
      });
      row.addEventListener('dragover', event => {
        if (!materialDragId || materialDragId === item.id) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', event => {
        if (!materialDragId || materialDragId === item.id) return;
        event.preventDefault();
        event.stopPropagation();
        const dragId = materialDragId;
        materialDragId = '';
        row.classList.remove('drop-target');
        reorderMaterial(dragId, materials.findIndex(candidate => candidate.id === item.id));
      });
      row.querySelector('button').addEventListener('click', event => {
        event.stopPropagation();
        const index = materials.findIndex(candidate => candidate.id === item.id);
        if (index >= 0) materials.splice(index, 1);
        renderMaterials();
      });
      list.appendChild(row);
    }
  }

  function addMaterials(files) {
    const counts = materialCounts();
    let added = 0;
    let skipped = 0;
    const existing = new Set(materials.map(item => `${item.file.name}|${item.file.size}|${item.file.lastModified}`));
    for (const file of Array.from(files || [])) {
      const kind = materialKind(file);
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (!kind || existing.has(key) || counts[kind] >= MATERIAL_LIMITS[kind]) {
        skipped += 1;
        continue;
      }
      existing.add(key);
      counts[kind] += 1;
      materials.push({ id: Math.random().toString(36).slice(2), kind, file });
      added += 1;
    }
    renderMaterials();
    status(skipped ? `已加入 ${added} 个，${skipped} 个因重复、格式或分类上限未加入` : `已加入 ${added} 个素材`, added ? 'ok' : 'warn');
  }

  async function moveMaterials() {
    const files = materials.map(item => item.file).filter(Boolean);
    if (!files.length) return status('请先选择或拖入本地素材', 'warn');
    const counts = materialCounts();
    if ((counts.video > 0 || counts.audio > 0) && !isSeedance25Selected()) {
      return status('视频,音频 素材仅支持2.5模型，请先更换模型', 'warn');
    }
    if (!(counts.video > 0 || counts.audio > 0) && !isImageUploadModelSelected()) {
      return status('请先在 AI 创作中切换到视频和 Seedance 2.5 / 2.0 Fast', 'warn');
    }
    enhanceSeedanceMediaSupport();
    const button = document.querySelector(`#${PANEL_ID} [data-action="move"]`);
    if (button) {
      button.disabled = true;
      button.textContent = '正在移入...';
    }
    try {
      const result = await addMaterialsToDolaReferenceStore(files);
      if (!result.ok) return status(result.reason || '素材移入失败', 'warn');
      const counts = result.counts || { image: 0, video: 0, audio: 0 };
      await patchDolaVideoSubmit();
      status(`素材已移入生成框：图片 ${counts.image}，视频 ${counts.video}，音频 ${counts.audio}`, 'ok');
    } catch (error) {
      status(`素材移入失败：${error?.message || 'Dola 上传管线异常'}`, 'warn');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '移入生成框';
      }
    }
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID}{position:fixed;inset:0;z-index:2147483600;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.42);font:13px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif;color:#172033}
      #${PANEL_ID}.open{display:flex}#${PANEL_ID} *{box-sizing:border-box}
      #${PANEL_ID} .wanwan-material-card{width:min(430px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;background:#fff;border:1px solid #dbe2ec;border-radius:18px;box-shadow:0 24px 70px rgba(15,23,42,.28);padding:18px}
      #${PANEL_ID} .wanwan-material-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}
      #${PANEL_ID} .wanwan-material-title{font-size:17px;font-weight:800;color:#172033}
      #${PANEL_ID} button{font:inherit;cursor:pointer}#${PANEL_ID} .wanwan-material-close{width:30px;height:30px;border:0;border-radius:9px;background:#f1f4f8;color:#526173;font-size:18px}
      #${PANEL_ID} .wanwan-material-tip{color:#64748b;font-size:12px;margin-bottom:12px}
      #${PANEL_ID} .wanwan-material-drop{min-height:132px;border:1.5px dashed #9bb7d7;border-radius:14px;background:#f8fbff;display:flex;align-items:center;justify-content:center;text-align:center;padding:18px;cursor:pointer;transition:.15s ease;color:#58708c}
      #${PANEL_ID} .wanwan-material-drop.drag{border-color:#6d55ef;background:#f2efff;transform:scale(1.005)}
      #${PANEL_ID} .wanwan-material-drop strong{display:block;color:#34465c;font-size:14px;margin-bottom:6px}
      #${PANEL_ID} .wanwan-material-count{font-size:12px;color:#64748b;margin:10px 1px 6px}
      #${PANEL_ID} .wanwan-material-list{max-height:150px;overflow:auto;border-radius:10px;background:#f8fafc}
      #${PANEL_ID} .wanwan-material-empty{text-align:center;color:#94a3b8;padding:12px}
      #${PANEL_ID} .wanwan-material-item{display:grid;grid-template-columns:12px minmax(0,1fr) 28px;gap:6px;align-items:center;padding:7px 9px;border-bottom:1px solid #e8edf3;cursor:grab}
      #${PANEL_ID} .wanwan-material-grip{color:#94a3b8;text-align:center;font-size:13px;user-select:none}
      #${PANEL_ID} .wanwan-material-item.dragging{opacity:.4}
      #${PANEL_ID} .wanwan-material-item.drop-target{box-shadow:inset 0 2px 0 #6552e8}
      #${PANEL_ID} .wanwan-material-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${PANEL_ID} .wanwan-material-item button{border:0;background:transparent;color:#ef4444;font-size:17px}
      #${PANEL_ID} .wanwan-material-move{width:100%;height:40px;margin-top:12px;border:1px solid #6552e8;border-radius:11px;background:#6552e8;color:#fff;font-weight:700}
      #${PANEL_ID} .wanwan-material-move:disabled{opacity:.58;cursor:wait}
      #${PANEL_ID} .wanwan-material-status{min-height:20px;text-align:center;margin-top:8px;color:#64748b;font-size:12px}
      #${PANEL_ID} .wanwan-material-status[data-type="ok"]{color:#16a34a}#${PANEL_ID} .wanwan-material-status[data-type="warn"]{color:#d97706}
      @media (prefers-color-scheme:dark){#${PANEL_ID} .wanwan-material-card{background:#272b33;border-color:#3e4653;color:#edf1f6}#${PANEL_ID} .wanwan-material-title{color:#f1f5f9}#${PANEL_ID} .wanwan-material-close{background:#343a45;color:#d8dee8}#${PANEL_ID} .wanwan-material-tip,#${PANEL_ID} .wanwan-material-count,#${PANEL_ID} .wanwan-material-status{color:#aab4c2}#${PANEL_ID} .wanwan-material-drop{background:#232730;border-color:#596678;color:#b9c3d1}#${PANEL_ID} .wanwan-material-drop strong{color:#e6ebf2}#${PANEL_ID} .wanwan-material-list{background:#232730}#${PANEL_ID} .wanwan-material-item{border-color:#39414d}}
    `;
    document.documentElement.appendChild(style);
  }

  function installPanel() {
    if (!document.body) return null;
    installStyle();
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.innerHTML = `<div class="wanwan-material-card" role="dialog" aria-modal="true" aria-label="素材上传">
      <div class="wanwan-material-head"><div class="wanwan-material-title">素材上传</div><button type="button" class="wanwan-material-close" title="关闭">×</button></div>
      <div class="wanwan-material-tip">图片可用 Seedance 2.5 / 2.0 Fast，视频、音频仅支持 2.5；列表内可拖动素材调整顺序。</div>
      <input class="wanwan-material-file" type="file" accept="${SEEDANCE_MEDIA_ACCEPT}" multiple hidden>
      <div class="wanwan-material-drop" tabindex="0"><div><strong>点击选择图片 / 视频 / 音频</strong><span>也可以直接把素材拖进这里</span></div></div>
      <div class="wanwan-material-count"></div><div class="wanwan-material-list"></div>
      <button type="button" class="wanwan-material-move" data-action="move">移入生成框</button>
      <div class="wanwan-material-status"></div>
    </div>`;
    document.body.appendChild(panel);
    const fileInput = panel.querySelector('.wanwan-material-file');
    const drop = panel.querySelector('.wanwan-material-drop');
    const close = () => panel.classList.remove('open');
    panel.querySelector('.wanwan-material-close').addEventListener('click', close);
    panel.addEventListener('click', event => { if (event.target === panel) close(); });
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
    fileInput.addEventListener('change', event => { addMaterials(event.target.files); fileInput.value = ''; });
    for (const type of ['dragenter', 'dragover']) {
      drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('drag'); });
    }
    for (const type of ['dragleave', 'drop']) drop.addEventListener(type, () => drop.classList.remove('drag'));
    drop.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
      addMaterials(event.dataTransfer?.files);
    });
    // 面板内其他区域松手也按“新增素材”处理，避免 WebView2 直接打开被拖入的文件。
    panel.addEventListener('dragover', event => event.preventDefault());
    panel.addEventListener('drop', event => {
      event.preventDefault();
      if (materialDragId) return;
      addMaterials(event.dataTransfer?.files);
    });
    panel.querySelector('[data-action="move"]').addEventListener('click', moveMaterials);
    // 列表空白处松手 = 移到末尾（只注册一次，避免随重渲染叠加监听）。
    const materialList = panel.querySelector('.wanwan-material-list');
    materialList.addEventListener('dragover', event => {
      if (!materialDragId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    materialList.addEventListener('drop', event => {
      if (!materialDragId) return;
      event.preventDefault();
      event.stopPropagation();
      const dragId = materialDragId;
      materialDragId = '';
      for (const row of materialList.querySelectorAll('.wanwan-material-item.drop-target')) row.classList.remove('drop-target');
      reorderMaterial(dragId, materials.length - 1);
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    renderMaterials();
    return panel;
  }

  function open() {
    const panel = installPanel();
    if (!panel) return false;
    panel.classList.add('open');
    renderMaterials();
    enhanceSeedanceMediaSupport();
    patchDolaVideoSubmit().catch(() => {});
    return true;
  }

  function close() {
    document.getElementById(PANEL_ID)?.classList.remove('open');
  }

  window.__WANWAN_MATERIAL_UPLOAD__ = { open, close, toggle: open, addMaterials, moveMaterials };
  if (window.__XINGCHEN_DOLA_TEST_MODE__) {
    window.__XINGCHEN_DOLA_REFERENCE_TEST_HOOKS__ = { getDolaWebpackRequire, findDolaInputProps, findDolaUploadPipeline, dolaPipelineCandidates, bestDolaPipelineCandidate, resolveDolaPipelineModule, dolaPipelineFunctionScore, runDolaUploadPipelineWithRetry, waitForDolaReferenceUpload, findNewDolaAttachment, dolaAttachmentKey, addMaterialsToDolaReferenceStore };
  }

  // 与国际豆包保持一致：页面脚本刚进入主世界就开始捕获上传模块，
  // 不能等到 DOMContentLoaded 后再 Hook，否则视频/音频上传工厂可能已经完成初始化。
  patchDolaMediaUploadRequests();
  watchDolaVideoUploadChunks();
  hookDolaVideoUploadChunk();
  patchDolaVideoSubmit().catch(() => {});
  const earlyHookStartedAt = Date.now();
  const earlyHookTimer = setInterval(() => {
    hookDolaVideoUploadChunk();
    patchDolaVideoSubmit().catch(() => {});
    if (Date.now() - earlyHookStartedAt > 15000 && typeof getDolaWebpackRequire() === 'function') {
      clearInterval(earlyHookTimer);
    }
  }, 80);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installPanel, { once: true });
  else installPanel();
  setInterval(() => {
    hookDolaVideoUploadChunk();
    enhanceSeedanceMediaSupport();
    patchDolaVideoSubmit().catch(() => {});
  }, 1500);
})();
