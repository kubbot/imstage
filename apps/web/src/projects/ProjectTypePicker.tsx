/**
 * Project type picker + structured project brief fields.
 *
 * The type cards show exactly which files a project of that type delivers
 * (from the shared recipe contract), so the user sees what will be produced
 * before creating. The brief is a structured OBJECT ({language?, platform?,
 * cast?}) — useful human controls only, never a raw JSON editor — and edits
 * merge onto the current brief so cast/avatar data restored by another client
 * is preserved.
 */
import type { Platform } from '../studio/model';
import type { ProjectBrief, ProjectBriefCastMember, ProjectType, ProjectTypeSummary } from '../account/api';
import { useScenarioCopy } from './scenarioCopy';
import { useLocale } from '../marketing/LocaleContext';

const TYPE_ORDER: ProjectType[] = ['training', 'demo', 'story', 'evaluation_dataset', 'custom'];

export function ProjectTypePicker({ types, value, onChange, disabled = false }: {
  types: ProjectTypeSummary[];
  value: ProjectType;
  onChange: (type: ProjectType) => void;
  disabled?: boolean;
}) {
  const s = useScenarioCopy();
  const { locale } = useLocale();
  const ordered = [...types].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  return (
    <fieldset className="project-type-picker" disabled={disabled}>
      <legend>{s.typeLegend}</legend>
      <p className="project-muted">{s.typeHint}</p>
      <div className="project-type-grid">
        {ordered.map((entry) => {
          const label = entry.name?.[locale] ?? entry.name?.zh ?? entry.type;
          const description = entry.description?.[locale] ?? entry.description?.zh ?? '';
          const extras = entry.extraDeliverables ?? [];
          return (
            <label key={entry.type} className={`project-type-card${value === entry.type ? ' is-selected' : ''}`}>
              <span className="project-type-head">
                <input
                  type="radio"
                  name="project-type"
                  className="project-template-radio"
                  aria-label={label}
                  value={entry.type}
                  checked={value === entry.type}
                  onChange={() => onChange(entry.type)}
                />
                <strong>{label}</strong>
                {entry.type === 'custom' && <small className="project-type-badge">{s.typeDefaultBadge}</small>}
              </span>
              <p className="project-type-desc">{description}</p>
              <p className="project-type-files">
                <span>{s.typeDeliverables}: </span>
                <code>{entry.requiredDeliverables.join(', ')}</code>
                {extras.length > 0 && (
                  <>
                    <br />
                    <span>{s.typeExtraDeliverables}: </span>
                    <code>{extras.join(', ')}</code>
                  </>
                )}
              </p>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const LANGUAGE_OPTIONS = ['zh-CN', 'en'];

export function ProjectBriefFields({ brief, onChange, disabled = false }: {
  brief: ProjectBrief;
  onChange: (brief: ProjectBrief) => void;
  disabled?: boolean;
}) {
  const s = useScenarioCopy();
  const cast: ProjectBriefCastMember[] = brief.cast ?? [];

  function updateCast(index: number, patch: Partial<ProjectBriefCastMember>) {
    // Merge onto the existing member so an avatar restored by another client
    // survives an edit of just the name/role.
    const next = cast.map((member, position) => (position === index ? { ...member, ...patch } : member));
    onChange({ ...brief, cast: next });
  }

  return (
    <fieldset className="project-brief-fields" disabled={disabled}>
      <legend>{s.briefLegend}</legend>
      <label>
        {s.briefLanguage}
        <select
          aria-label={s.briefLanguage}
          value={brief.language ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            // Explicit `undefined` clears the language; cast/avatar stay intact.
            onChange({ language: value === '' ? undefined : value });
          }}
        >
          <option value="">{s.briefLanguageHint}</option>
          {LANGUAGE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <fieldset className="project-cast">
        <legend>{s.briefCast}</legend>
        <p className="project-muted">{s.briefCastHint}</p>
        {cast.map((member, index) => (
          <div key={index} className="project-cast-row">
            <input
              aria-label={`${s.briefCastName} ${index + 1}`}
              value={member.name ?? ''}
              maxLength={80}
              placeholder={s.briefCastName}
              onChange={(event) => updateCast(index, { name: event.target.value })}
            />
            <input
              aria-label={`${s.briefCastRole} ${index + 1}`}
              value={member.role ?? ''}
              maxLength={80}
              placeholder={s.briefCastRole}
              onChange={(event) => updateCast(index, { role: event.target.value })}
            />
            <button
              type="button"
              className="text-link"
              onClick={() => onChange({ ...brief, cast: cast.filter((unused, position) => position !== index) })}
            >
              {s.briefCastRemove}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="agent-button"
          disabled={cast.length >= 20}
          onClick={() => onChange({ ...brief, cast: [...cast, { name: '', role: '' }] })}
        >
          {s.briefCastAdd}
        </button>
      </fieldset>
    </fieldset>
  );
}

export type { Platform };
