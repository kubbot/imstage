/**
 * Shared platform template picker: every supported chat template is offered as
 * a real, selectable card with a live local preview — the IMStage generic skin
 * plus WeChat, WhatsApp, iMessage, Instagram, Xiaohongshu and Slack. One shared
 * implementation serves both project creation and scenario creation (no
 * duplicated preview code, no circular imports).
 *
 * Previews render the shared synthetic sample locally (no network, no model
 * calls, no reference images) and react to the watermark switch. Keyboard
 * semantics stay a native radio group.
 */
import { useMemo } from 'react';
import { PLATFORMS, createScene, type Platform, type Scene } from '../studio/model';
import { SceneView } from '../studio/SceneView';
import { ScaledSceneFrame } from '../marketing/DeviceFrame';
import { useCopy } from '../i18n';
import { useScenarioCopy } from './scenarioCopy';

export const TEMPLATE_PREVIEW_DEVICE = { width: 402, height: 470 };

export function platformPreviewScene(platform: Platform, watermarkEnabled: boolean): Scene {
  return {
    ...createScene('weekend'),
    id: `template-preview-${platform}`,
    platform,
    title: '',
    ...(watermarkEnabled ? {} : { watermarkEnabled: false }),
  };
}

function TemplateOption({ group, platform, label, selected, watermarkEnabled, onSelect, previewLabel }: {
  group: string;
  platform: Platform;
  label: string;
  selected: boolean;
  watermarkEnabled: boolean;
  onSelect: () => void;
  previewLabel: string;
}) {
  const scene = useMemo(() => platformPreviewScene(platform, watermarkEnabled), [platform, watermarkEnabled]);
  return (
    <label className={`project-template-card${selected ? ' is-selected' : ''}`}>
      <span className="project-template-head">
        <input
          type="radio"
          name={group}
          className="project-template-radio"
          aria-label={label}
          value={platform}
          checked={selected}
          onChange={onSelect}
        />
        <strong>{label}</strong>
      </span>
      {/* The miniature conversation is a read-only template picture: expose it
          as one labeled image instead of seven irrelevant sample message trees. */}
      <span className="project-template-preview" role="img" aria-label={previewLabel}>
        <span aria-hidden="true" style={{ display: 'contents' }}>
          <ScaledSceneFrame size={TEMPLATE_PREVIEW_DEVICE}>
            <SceneView scene={scene} exportMode />
          </ScaledSceneFrame>
        </span>
      </span>
    </label>
  );
}

export function PlatformCards({ group, value, watermarkEnabled, onChange, copy }: {
  group: string;
  value: Platform;
  watermarkEnabled: boolean;
  onChange: (platform: Platform) => void;
  copy: { templateLegend: string; templatePreview: (name: string) => string };
}) {
  const labels = useCopy().platforms;
  return (
    <fieldset className="project-templates">
      <legend>{copy.templateLegend}</legend>
      <div className="project-template-grid">
        {PLATFORMS.map((platform) => (
          <TemplateOption
            key={platform}
            group={group}
            platform={platform}
            label={labels[platform]}
            selected={value === platform}
            watermarkEnabled={watermarkEnabled}
            onSelect={() => onChange(platform)}
            previewLabel={copy.templatePreview(labels[platform])}
          />
        ))}
      </div>
    </fieldset>
  );
}

/** Localized platform label helper shared by the scenario panel. */
export function usePlatformLabels(): Record<string, string> {
  return useCopy().platforms;
}

/** Hierarchy labels (项目 / 场景 / 案例) from the localized scenario copy. */
export function useHierarchyLabels() {
  const s = useScenarioCopy();
  return { project: s.projectLabel, scenario: s.scenarioLabel, caseLabel: s.caseLabel, hierarchy: s.hierarchy };
}
