import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateScene } from '../apps/web/src/studio/model.ts';
import { calendarToday, isCalendarDate, timelinePresentation } from '../packages/schema/timeline.mjs';
import { buildInitialMessages } from '../services/agent/prompt.mjs';
import { evaluateAnniversary } from '../tools/eval/src/timeline.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('../tools/eval/fixtures/loan-anniversary.json',import.meta.url),'utf8'));
const fresh=()=>structuredClone(fixture.scene);
test('anniversary fixture preserves dates, order and deterministic two-day labels across JSON roundtrip',()=>{
 const result=validateScene(JSON.parse(JSON.stringify(fresh())));assert.equal(result.ok,true);
 assert.equal(evaluateAnniversary(result.scene,fixture).passed,true);
 assert.deepEqual(timelinePresentation(result.scene).entries.filter(e=>e.dateLabel).map(e=>e.dateLabel),['2025年9月21日','今天']);
});
test('the evaluator fails all-today storytelling, reversed days, missing agreement and false repayment',()=>{
 const today=fresh();today.messages.forEach(m=>m.date='2026-09-21');assert.equal(evaluateAnniversary(today,fixture).passed,false);
 const reverse=fresh();reverse.messages.reverse();assert.equal(evaluateAnniversary(reverse,fixture).passed,false);
 const missing=fresh();missing.messages=missing.messages.filter(m=>['reminder','repayment','confirmed'].includes(m.id));assert.equal(evaluateAnniversary(missing,fixture).passed,false);
 const unpaid=fresh();unpaid.messages.find(m=>m.id==='repayment').text='我还没凑够钱。';assert.equal(evaluateAnniversary(unpaid,fixture).passed,false);
});
test('legacy duplicate Today is hidden without destroying the underlying editable message',()=>{
 const scene=fresh();delete scene.referenceDate;scene.date='今天';scene.messages=[{id:'date',participantId:'',type:'system',text:'今天',time:''},{id:'notice',participantId:'',type:'system',text:'今天已开启消息保护',time:''}];
 const view=timelinePresentation(scene);assert.equal(view.header,'今天');assert.equal(view.entries[0].hidden,true);assert.equal(view.entries[1].hidden,false);assert.equal(scene.messages.length,2);
});
test('date validation catches impossible dates and reference date; timezone rollover is explicit',()=>{
 assert.equal(isCalendarDate('2025-02-29'),false);assert.equal(isCalendarDate('2024-02-29'),true);
 assert.equal(calendarToday(new Date('2026-09-20T16:30:00Z')),'2026-09-21');
 const scene=fresh();scene.messages[0].date='2025-02-30';assert.equal(validateScene(scene).ok,false);
 scene.messages[0].date='2025-09-21';scene.referenceDate='today';assert.equal(validateScene(scene).ok,false);
});
test('provider context contains frozen reference date and per-message dates',()=>{
 const messages=buildInitialMessages({prompt:fixture.input,scene:fresh()});
 assert.match(messages[0].content,/2026-09-21/);assert.match(messages[0].content,/Message.date/);assert.match(messages.at(-1).content,/2025-09-21/);
});

test('repayment accepts transfer cards with lender receipt but rejects negation and reversed payer',()=>{
 const scene=fresh();const pay=scene.messages.find(m=>m.id==='repayment');pay.type='transfer';pay.text='转账 500万元';assert.equal(evaluateAnniversary(scene,fixture).passed,true);
 pay.type='text';pay.text='500万元还没有归还';assert.equal(evaluateAnniversary(scene,fixture).passed,false);
 pay.text='500万元已经归还';pay.participantId='me';assert.equal(evaluateAnniversary(scene,fixture).passed,false);
 pay.participantId='achuan';scene.messages.find(m=>m.id==='confirmed').text='还没收到';assert.equal(evaluateAnniversary(scene,fixture).passed,false);
});
