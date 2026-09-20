const $=id=>document.getElementById(id);
let data=null, selected=location.hash.slice(1), reviewKind='actual',verdict=null,busy=false;
const list=value=>Array.isArray(value)?value:[];
const text=(id,value)=>{$(id).textContent=value??'';};
const badge=v=>v?.review?.golden?'已确认金标':v?.review?.verdict==='good'?'你已标为好':v?.review?.verdict==='bad'?'需要改进':v?.staleReview?'旧标注已过期':'待你确认';
function current(){return data?.cases.find(c=>c.id===selected);}
async function request(url,options={}){const res=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const result=await res.json();if(!res.ok)throw new Error(result.error??'请求失败');return result;}
async function load(){try{data=await request('/api/dataset');$('dataset-error').hidden=true;$('loading').hidden=true;$('content').hidden=false;if(!current())selected=data.cases[0]?.id;render();}catch(e){text('dataset-error',e.message);$('dataset-error').hidden=false;$('loading').hidden=true;}}
function render(){
 text('count',data.cases.length);const query=$('search').value.toLowerCase(),difficulty=$('difficulty').value;
 $('cases').replaceChildren();
 for(const c of data.cases.filter(c=>(!difficulty||String(c.difficulty)===difficulty)&&`${c.id} ${c.title} ${c.im} ${c.task}`.toLowerCase().includes(query))){const b=document.createElement('button');b.setAttribute('aria-current',String(c.id===selected));const m=document.createElement('small');m.textContent=`${c.id} · ${c.im} / ${c.surface}   L${c.difficulty}`;const title=document.createElement('b');title.textContent=c.title;b.append(m,title);b.onclick=()=>{selected=c.id;history.replaceState(null,'','#'+c.id);render();};$('cases').append(b);}
 const c=current();if(!c)return;
 text('case-meta',`${c.id} / ${c.im.toUpperCase()} · ${c.surface} / 难度 ${c.difficulty} OF 5`);text('title',c.title);text('task',c.task);text('answer',c.expected.answer);text('source-size',`${c.source.width} × ${c.source.height}`);
 const report=data.report; text('suite-status',report?`本轮 ${report.counts?.casesPassed??0} / ${report.counts?.casesTotal??data.cases.length} 自动通过`:'等待首次运行');
 for(const kind of ['source','expected','actual']){
   const v=c.variants[kind];$(kind).hidden=!v;$(kind+'-link').hidden=!v;
   if(v){$(kind).src=v.url;$(kind+'-link').href=v.url;}else{$(kind).removeAttribute('src');$(kind+'-link').removeAttribute('href');}
   if(kind!=='source'){$(kind+'-empty').hidden=!!v;text(kind+'-badge',v?badge(v):(kind==='actual'?c.run?.errorCode??'未运行':'未生成'));document.querySelector(`[data-kind="${kind}"]`).disabled=!v;}
 }
 $('analysis').replaceChildren();for(const s of [...list(c.analysis.observed),...list(c.analysis.unchanged).map(s=>'保持：'+s),...list(c.analysis.risks).map(s=>'检查：'+s)]){const li=document.createElement('li');li.textContent=s;$('analysis').append(li);}
 const entry=report?.cases?.find(e=>e.id===c.id||e.caseId===c.id);const checks=c.run?.scoring?.checks??c.run?.checks??entry?.checks??[];text('score-summary',entry?`${entry.passed?'通过':'未通过'} · ${Math.round((entry.score??0)*100)} 分`:'待运行');
 $('checks').replaceChildren();if(checks.length){const table=document.createElement('table');for(const ch of checks){const tr=document.createElement('tr');for(const value of [ch.passed?'✓':'×',ch.id,ch.reasonCode??'']){const td=document.createElement('td');td.textContent=value;tr.append(td);}table.append(tr);}$('checks').append(table);}else{const p=document.createElement('p');p.textContent=c.run?.errorCode?`运行未完成：${c.run.errorCode}`:'尚无可显示的检查结果。';$('checks').append(p);}
}
function openReview(kind){reviewKind=kind;const v=current().variants[kind];verdict=v.review?.verdict??null;text('review-title',kind==='actual'?'评判 DeepSeek 输出':'评判参考答案');text('review-state',badge(v));$('note').value=v.review?.note??'';$('good').setAttribute('aria-pressed',verdict==='good');$('bad').setAttribute('aria-pressed',verdict==='bad');$('golden').hidden=verdict!=='good'||!!v.review?.golden;$('clear').hidden=!v.review;text('review-error','');$('review-dialog').showModal();}
async function save(action=verdict){if(busy)return;if(!action){text('review-error','先选择好或不好。');return;}busy=true;for(const id of ['save','golden','clear','close'])$(id).disabled=true;try{const c=current(),v=c.variants[reviewKind];await request(`/api/dataset/${c.id}/review`,{method:'POST',body:JSON.stringify({revision:data.revision,kind:reviewKind,hash:v.hash,verdict:action,note:$('note').value})});$('review-dialog').close();await load();}catch(e){text('review-error',e.message);}finally{busy=false;for(const id of ['save','golden','clear','close'])$(id).disabled=false;}}
$('search').oninput=render;$('difficulty').onchange=render;$('refresh').onclick=load;document.querySelectorAll('.review-open').forEach(b=>b.onclick=()=>openReview(b.dataset.kind));$('close').onclick=()=>$('review-dialog').close();for(const v of ['good','bad'])$(v).onclick=()=>{verdict=v;$('good').setAttribute('aria-pressed',v==='good');$('bad').setAttribute('aria-pressed',v==='bad');$('golden').hidden=true;};$('save').onclick=()=>save();$('golden').onclick=()=>save('golden');$('clear').onclick=()=>save('clear');window.addEventListener('hashchange',()=>{selected=location.hash.slice(1);render();});load();
