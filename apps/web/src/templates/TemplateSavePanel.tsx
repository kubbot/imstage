import { useEffect, useRef, useState } from 'react';
import { IconBookmark, IconLoader2, IconX } from '@tabler/icons-react';
import { api, errorText, type TemplateDetail } from '../account/api';
import { useCopy } from '../i18n';
import { discoverTemplateVariables } from '../../../../packages/schema/templates.ts';
import type { Scene } from '../studio/model';

/**
 * Compact "save the current editable frame as a reusable template" dialog.
 * It reuses the shared pure discovery + validator contract: the scene is
 * frozen server-side, an explicit name is required and every variable is
 * opt-in. Nothing is sent to a provider.
 */
export default function TemplateSavePanel({ scene, locked, onSaved }: { scene: Scene; locked: boolean; onSaved?: (item: TemplateDetail) => void }) {
  const copy = useCopy();
  const t = copy.templates;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [variables, setVariables] = useState(() => discoverTemplateVariables(scene));
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(discoverTemplateVariables(scene).map(v => v.key)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) {
      const discovered = discoverTemplateVariables(scene);
      setVariables(discovered);
      setEnabled(new Set(discovered.map(v => v.key)));
      setName((current) => current || scene.title || '');
      setDescription('');
      setError('');
      setSaved(false);
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [open, scene]);

  async function save() {
    if (busy) return;
    if (name.trim() === '') { setError(t.needName); return; }
    setBusy(true);
    setError('');
    try {
      const selected = variables.filter(variable => enabled.has(variable.key));
      const data = await api<{ item: TemplateDetail }>('/templates', {
        method: 'POST',
        body: { name: name.trim(), description: description.trim(), scene, variables: selected },
      });
      setSaved(true);
      onSaved?.(data.item);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="agent-button" aria-haspopup="dialog" disabled={locked} onClick={() => setOpen(true)}>
        <IconBookmark size={16} /> {t.saveCurrent}
      </button>
      <dialog ref={dialog} className="account-dialog template-dialog" aria-label={t.saveTitle} onCancel={() => setOpen(false)}>
        <header>
          <h2>{t.saveTitle}</h2>
          <button type="button" className="icon-btn" aria-label={t.close} onClick={() => setOpen(false)}><IconX size={17} /></button>
        </header>
        <p className="template-dialog-note">{t.saveBody}</p>
        <label>{t.nameLabel}<input aria-label={t.nameLabel} value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
        <label>{t.descriptionLabel}<textarea aria-label={t.descriptionLabel} value={description} rows={2} maxLength={500} onChange={event => setDescription(event.target.value)} /></label>
        {variables.length > 0 ? (
          <fieldset className="template-variable-list">
            <legend>{t.variablesTitle} <span>{t.variablesSelected(enabled.size, variables.length)}</span></legend>
            <p className="template-dialog-note">{t.variablesHint}</p>
            {variables.map(variable => (
              <label key={variable.key} className="template-variable">
                <input type="checkbox" checked={enabled.has(variable.key)} onChange={event => setEnabled(current => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(variable.key); else next.delete(variable.key);
                  return next;
                })} />
                <span>{variable.label}</span>
                <small>{copy.messageTypes[variable.type]} · {variable.key}</small>
              </label>
            ))}
          </fieldset>
        ) : <p className="template-dialog-note">{t.noVariables}</p>}
        {error && <p role="alert" className="account-error">{error}</p>}
        {saved && <p role="status" className="template-saved">{t.savedOk}</p>}
        <div className="template-dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>{t.close}</button>
          <button type="button" className="btn btn-primary" disabled={busy || saved || name.trim() === ''} onClick={() => void save()}>
            {busy ? <IconLoader2 size={15} className="projects-spin" /> : <IconBookmark size={15} />} {busy ? t.saving : t.saveAction}
          </button>
        </div>
      </dialog>
    </>
  );
}
