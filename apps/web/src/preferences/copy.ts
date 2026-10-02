import type { Locale } from '../marketing/locale';

export type PreferencesCopy = {
  title: string;
  lede: string;
  myAvatar: { title: string; help: string };
  otherAvatar: { title: string; help: string; generate: string; generating: string; generated: string };
  mark: { title: string; label: string; help: string };
  upload: string;
  dropTitle: string;
  dropHint: string;
  formats: string;
  crop: { legend: string; zoom: string; x: string; y: string };
  preview: string;
  previewTitle: string;
  replace: string;
  restore: string;
  retry: string;
  remove: string;
  save: string;
  saving: string;
  useDefaults: string;
  confirmCrop: string;
  cancelCrop: string;
  offlineContinue: string;
  offlineNote: string;
  skipNote: string;
  loading: string;
  loadFailed: string;
  saveFailed: string;
  draftNotice: string;
  storageNotice: string;
  builtinFallback: string;
  markOnNote: string;
  markOffNote: string;
  customMarkNote: string;
  referenceNote: string;
  settingsTitle: string;
  back: string;
  avatarAlt: string;
  otherAvatarAlt: string;
};

const ZH: PreferencesCopy = {
  title: '让对话更像你的作品',
  lede: '设置账号默认头像与虚构标记。不填写任何内容也能直接开始创作。',
  myAvatar: { title: '我的头像', help: '上传后按比例裁成 256×256，仅用于你的作品，不会进入公开素材库。' },
  otherAvatar: { title: '对方默认头像', help: '系统为你准备的虚构头像，可以换一个或上传一张图片。', generate: '换一个', generating: '生成中…', generated: '已生成' },
  mark: { title: '虚构标识（默认开启）', label: '新场景默认显示「AI生成 / 虚构」水印', help: '新建作品的预览与导出默认带有「AI生成 / 虚构」水印。项目与画面提供水印开关（默认开启）；关闭只影响所选项目/画面，不会改写已保存的作品，AI 也不能修改你的选择。' },
  upload: '上传图片',
  dropTitle: '拖放图片到这里',
  dropHint: '或点击选择文件',
  formats: '支持 PNG / JPEG / WebP，单张不超过 2 MiB',
  crop: { legend: '方形裁剪', zoom: '缩放', x: '水平位置', y: '垂直位置' },
  preview: '预览',
  previewTitle: '实时示例',
  replace: '替换',
  restore: '恢复默认',
  retry: '重试',
  remove: '移除',
  save: '保存并开始',
  saving: '保存中…',
  useDefaults: '先用默认设置',
  confirmCrop: '确认裁剪',
  cancelCrop: '取消',
  offlineContinue: '先不设置，直接开始',
  offlineNote: '账号服务暂时不可用，本次个性化设置不会保存；你可以随时从账号设置重新配置。',
  skipNote: '跳过不会保存任何个性化内容，你随时可以从账号设置重新进入。',
  loading: '正在读取账号偏好…',
  loadFailed: '偏好读取失败，可以使用默认设置继续，或重试。',
  saveFailed: '保存失败，已保留你的修改，请重试。',
  draftNotice: '已从上次中断的地方恢复草稿。',
  storageNotice: '浏览器未保存草稿，本次设置仍可在当前页面使用。',
  builtinFallback: '生成失败，已使用内置默认头像，可重试。',
  markOnNote: '「AI生成 / 虚构」水印默认显示；可在项目或画面设置中关闭。',
  markOffNote: '「AI生成 / 虚构」水印默认显示；可在项目或画面设置中关闭。',
  customMarkNote: '当前场景已有自定义水印；关闭水印开关会同时隐藏自定义水印文字。',
  referenceNote: '当前是截图保留模式，原图内嵌文字无法通过此开关移除。',
  settingsTitle: '账号偏好',
  back: '返回',
  avatarAlt: '我的头像预览',
  otherAvatarAlt: '对方默认头像预览',
};

const EN: PreferencesCopy = {
  title: 'Make conversations look like your work',
  lede: 'Set account default avatars and the fictional mark. You can start creating without filling anything in.',
  myAvatar: { title: 'My avatar', help: 'Cropped proportionally to 256×256 and used only in your own works. It is never added to a public asset library.' },
  otherAvatar: { title: 'Default other avatar', help: 'A fictional avatar prepared for you. Swap it or upload your own image.', generate: 'Another', generating: 'Generating…', generated: 'Generated' },
  mark: { title: 'Fictional label (on by default)', label: 'New scenes show the “AI-generated / fictional” watermark by default', help: 'Previews and exports of new works carry the AI生成 / 虚构 watermark by default. Projects and scenes have a watermark switch (default on); turning it off affects only that project/scene, never rewrites saved works, and the AI can never change your choice.' },
  upload: 'Upload image',
  dropTitle: 'Drop an image here',
  dropHint: 'or click to choose a file',
  formats: 'PNG / JPEG / WebP, up to 2 MiB each',
  crop: { legend: 'Square crop', zoom: 'Zoom', x: 'Horizontal position', y: 'Vertical position' },
  preview: 'Preview',
  previewTitle: 'Live preview',
  replace: 'Replace',
  restore: 'Restore default',
  retry: 'Retry',
  remove: 'Remove',
  save: 'Save and start',
  saving: 'Saving…',
  useDefaults: 'Use default settings',
  confirmCrop: 'Apply crop',
  cancelCrop: 'Cancel',
  offlineContinue: 'Start without personalizing',
  offlineNote: 'The account service is unavailable, so these personalization changes will not be saved. You can configure them later from account settings.',
  skipNote: 'Skipping saves no personalization. You can reopen onboarding from account settings at any time.',
  loading: 'Reading account preferences…',
  loadFailed: 'Could not load preferences. You can continue with defaults or retry.',
  saveFailed: 'Saving failed. Your changes are kept; please retry.',
  draftNotice: 'Restored the draft from where you left off.',
  storageNotice: 'The browser did not store a draft; these settings still apply on this page.',
  builtinFallback: 'Generation failed. A built-in default avatar is used; you can retry.',
  markOnNote: 'The AI-generated / fictional label is always visible in the image and cannot be disabled.',
  markOffNote: 'The AI-generated / fictional label is always visible in the image and cannot be disabled.',
  customMarkNote: 'This scene already has a custom watermark; turning the watermark switch off hides it together with the mark.',
  referenceNote: 'This is screenshot-preserve mode; labels embedded in the original pixels cannot be removed by this switch.',
  settingsTitle: 'Account preferences',
  back: 'Back',
  avatarAlt: 'My avatar preview',
  otherAvatarAlt: 'Default other avatar preview',
};

export function preferencesCopy(locale: Locale): PreferencesCopy {
  return locale === 'en' ? EN : ZH;
}

export function avatarErrorText(code: string, locale: Locale): string {
  const table: Record<string, [string, string]> = {
    no_file: ['没有选择文件', 'No file selected'],
    type: ['仅支持 PNG / JPEG / WebP 图片', 'Only PNG / JPEG / WebP images are supported'],
    size: ['图片需小于 2 MiB', 'The image must be under 2 MiB'],
    read: ['读取图片失败，请重试', 'Could not read the image. Please retry'],
    decode: ['图片无法解码，请更换文件', 'The image could not be decoded. Try another file'],
    canvas_unavailable: ['浏览器无法裁剪图片，请更换浏览器', 'This browser cannot crop images'],
  };
  const entry = table[code];
  if (!entry) return locale === 'en' ? 'The image could not be used.' : '图片无法使用。';
  return locale === 'en' ? entry[1] : entry[0];
}
