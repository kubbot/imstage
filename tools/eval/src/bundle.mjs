import { BUNDLE_SCHEMA_VERSION, MAX_CASES, PNG_MATCH_THRESHOLD, RUBRIC_VERSION } from './constants.mjs';
import { AppError, fail, newId, nowIso } from './util.mjs';
import { isExportableGolden } from './fingerprint.mjs';
import { validateBundle } from './validate.mjs';

async function blobOrFail(store, sha256, label) {
  const buffer = await store.getBlob(sha256);
  if (!buffer) fail('missing_blob', `${label} 的二进制内容缺失 (${sha256})`, 500);
  return buffer;
}

/**
 * Build a self-contained golden bundle. Only human-approved, currently-bound
 * goldens are admitted. Scope `synthetic` additionally requires the explicit
 * synthetic flag so private/user data cannot leak into Git or CI.
 */
export async function exportBundle({ store, scope = 'private', caseIds = null }) {
  if (scope !== 'private' && scope !== 'synthetic') {
    fail('invalid_scope', 'scope 只能是 private 或 synthetic', 422);
  }
  const exportable = store.listCases().filter((c) => isExportableGolden(c));
  let selected = exportable;
  if (Array.isArray(caseIds) && caseIds.length > 0) {
    const wanted = new Set(caseIds);
    selected = exportable.filter((c) => wanted.has(c.id));
  }
  if (scope === 'synthetic') {
    selected = selected.filter((c) => c.synthetic === true);
  }
  const cases = [];
  for (const c of selected) {
    const attachments = [];
    for (const att of c.attachments ?? []) {
      const buffer = await blobOrFail(store, att.sha256, `用例 ${c.id} 附件 ${att.name}`);
      attachments.push({
        name: att.name,
        kind: att.kind,
        mime: att.mime,
        size: att.size,
        sha256: att.sha256,
        base64: buffer.toString('base64'),
      });
    }
    const goldenBuffer = await blobOrFail(store, c.candidate.sha256, `用例 ${c.id} 金标 PNG`);
    cases.push({
      bundleCaseId: c.id,
      question: c.question,
      inputLanguage: c.inputLanguage,
      targetIM: c.targetIM,
      surface: c.surface,
      outputKind: c.outputKind,
      width: c.width,
      height: c.height,
      notes: c.notes ?? '',
      inputFingerprint: c.golden.inputFingerprint,
      maxDiffRatio: c.golden.maxDiffRatio,
      synthetic: c.synthetic === true,
      rubricVersion: c.review.rubricVersion ?? RUBRIC_VERSION,
      scores: c.review.scores,
      verdict: 'good',
      reason: c.review.reason ?? '',
      reviewFingerprint: c.review.fingerprint,
      reviewedAt: c.review.reviewedAt ?? null,
      attachments,
      goldenPng: {
        sha256: c.candidate.sha256,
        width: c.candidate.width,
        height: c.candidate.height,
        base64: goldenBuffer.toString('base64'),
      },
    });
  }
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: 'imstage-eval-golden-bundle',
    generator: `imstage-eval@${RUBRIC_VERSION}`,
    exportedAt: nowIso(),
    scope,
    threshold: PNG_MATCH_THRESHOLD,
    rubricVersion: RUBRIC_VERSION,
    cases,
  };
}

/**
 * Import a validated bundle. Only non-destructive imports are supported: every
 * case receives a fresh id. The global store revision is required and checked
 * inside the serialized mutation so a concurrent writer cannot be clobbered.
 */
export async function importBundle({ rawBundle, store, expectedRevision }) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    fail('missing_revision', '导入必须携带整数 revision（乐观并发控制）', 428);
  }
  const bundle = validateBundle(rawBundle, { requireSafeIds: true });
  for (const bc of bundle.cases) {
    for (const att of bc.attachments) await store.putBlob(att.buffer);
    await store.putBlob(bc.goldenPng.buffer);
  }
  return store.mutate((draft) => {
    if (draft.revision !== expectedRevision) {
      const err = new AppError(
        'revision_conflict',
        `revision 冲突：期望 ${expectedRevision}，当前 ${draft.revision}`,
        409,
      );
      err.details = { expected: expectedRevision, actual: draft.revision };
      throw err;
    }
    if (draft.cases.length + bundle.cases.length > MAX_CASES) {
      fail('too_many_cases', `导入后将超过 ${MAX_CASES} 条用例上限`, 422);
    }
    const importedIds = [];
    for (const bc of bundle.cases) {
      const timestamp = nowIso();
      const id = newId('c');
      const attachments = bc.attachments.map((att) => ({
        id: newId('att'),
        name: att.name,
        kind: att.kind,
        mime: att.mime,
        size: att.size,
        sha256: att.sha256,
        addedAt: timestamp,
        synthetic: bc.synthetic === true,
      }));
      const caseData = {
        id,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        question: bc.question,
        inputLanguage: bc.inputLanguage,
        targetIM: bc.targetIM,
        surface: bc.surface,
        outputKind: bc.outputKind,
        width: bc.width,
        height: bc.height,
        notes: bc.notes,
        maxDiffRatio: bc.maxDiffRatio,
        synthetic: bc.synthetic === true,
        attachments,
        candidate: {
          id: newId('cand'),
          name: `${id}.png`,
          mime: 'image/png',
          size: bc.goldenPng.buffer.length,
          sha256: bc.goldenPng.sha256,
          width: bc.goldenPng.width,
          height: bc.goldenPng.height,
          uploadedAt: timestamp,
          inputFingerprint: bc.inputFingerprint,
          synthetic: bc.synthetic === true,
        },
        review: {
          status: 'reviewed',
          scores: bc.review.scores,
          verdict: 'good',
          reason: bc.review.reason,
          rubricVersion: bc.review.rubricVersion,
          candidateSha256: bc.goldenPng.sha256,
          inputFingerprint: bc.inputFingerprint,
          fingerprint: bc.review.fingerprint,
          reviewedAt: bc.review.reviewedAt ?? timestamp,
        },
        golden: {
          approved: true,
          approvedAt: timestamp,
          fingerprint: bc.goldenFingerprint,
          candidateSha256: bc.goldenPng.sha256,
          inputFingerprint: bc.inputFingerprint,
          maxDiffRatio: bc.maxDiffRatio,
          reviewFingerprint: bc.review.fingerprint,
        },
      };
      draft.cases.push(caseData);
      importedIds.push(id);
    }
    return importedIds;
  });
}
