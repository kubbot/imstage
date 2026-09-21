import { validateScene } from '../../../apps/web/src/studio/model.ts';
import { isDateMarker, timelinePresentation } from '../../../packages/schema/timeline.mjs';

/** Independent acceptance predicates, not a screenshot self-comparison. */
export function evaluateAnniversary(scene, fixture) {
  const validation = validateScene(scene);
  const checks = [];
  const check = (id, pass, detail) => checks.push({ id, pass:Boolean(pass), detail });
  check('valid-contract', validation.ok, validation.errors.join('; '));
  if (!validation.ok) return { caseId:fixture.id, passed:false, checks };
  const { pastDate, currentDate, dateLabels, amount, deviceProfileId, notice } = fixture.expectations;
  const old = scene.messages.filter(m=>m.date===pastDate && m.type!=='system');
  const current = scene.messages.filter(m=>m.date===currentDate && m.type!=='system');
  const dates = scene.messages.filter(m=>m.type!=='system').map(m=>m.date);
  const labels = timelinePresentation(scene).entries.filter(e=>e.dateLabel).map(e=>e.dateLabel);
  check('iphone-device', scene.deviceProfileId===deviceProfileId && scene.surface==='ios', scene.deviceProfileId);
  check('frozen-reference-date', scene.referenceDate===currentDate, scene.referenceDate);
  check('last-year-conversation', old.length>=2 && old.some(m=>/借/.test(m.text)&&m.text.includes(amount)), `${old.length} historical messages`);
  check('explicit-agreement', old.some(m=>/一年|明年|2026年9月21日/.test(m.text)) && old.some(m=>/还|归还/.test(m.text)), 'Agreement belongs to the historical section');
  const affirmative = text => !/未|没|尚未|还没|没有|稍后|等会|明天|将会/.test(text);
  const payment = current.some(m=>m.participantId!==scene.selfId && m.text.includes(amount) && affirmative(m.text) && (m.type==='transfer'||/已经.{0,8}(还|转)|已.{0,4}(归还|还清|转账)|归还了|还清了|转好了/.test(m.text)));
  const receipt = current.some(m=>m.participantId===scene.selfId && affirmative(m.text) && /收到|到账|结清/.test(m.text));
  check('today-repayment', payment && receipt, `${current.length} current messages; completed payment=${payment}; lender receipt=${receipt}`);
  check('chronological-days', dates.every(d=>d===pastDate||d===currentDate) && dates.every((d,i)=>i===0||d>=dates[i-1]), dates.join(', '));
  check('one-separator-per-day', JSON.stringify(labels)===JSON.stringify(dateLabels), labels.join(' / '));
  check('no-date-as-system-message', !scene.messages.some(m=>m.type==='system'&&isDateMarker(m.text)), 'Date labels belong to renderer');
  check('synthetic-disclosure', scene.watermark.includes(notice), scene.watermark);
  return { caseId:fixture.id, passed:checks.every(c=>c.pass), checks };
}
