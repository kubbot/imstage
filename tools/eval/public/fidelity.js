const root=document.querySelector('#cases');
try {
 const response=await fetch('/api/device-fidelity');if(!response.ok)throw new Error('读取失败，请刷新重试');const suite=await response.json();root.textContent='';
 for(const item of suite.cases){
  const card=document.createElement('article');const title=document.createElement('h2');title.textContent=`${item.id} · ${item.title}`;
  const meta=document.createElement('small');meta.textContent=`L${item.difficulty} · ${item.deviceProfileId} · ${item.visualStatus}`;
  const prompt=document.createElement('p');prompt.textContent=item.prompt;
  const heading=document.createElement('h3');heading.textContent='期望答案 / 验收规则';
  const list=document.createElement('ul');for(const rule of item.answer.assertions){const li=document.createElement('li');li.textContent=rule;list.append(li);}
  const dimensions=document.createElement('p');dimensions.textContent=item.answer.dimensions?`标准 PNG：${item.answer.dimensions.join(' × ')} px`:item.answer.width?`长截图：宽 ${item.answer.width} px，高 > ${item.answer.minHeightExclusive} px`:'';
  card.append(meta,title,prompt,heading,list,dimensions);root.append(card);
 }
}catch(error){root.textContent='';document.querySelector('#error').textContent=error.message;}
