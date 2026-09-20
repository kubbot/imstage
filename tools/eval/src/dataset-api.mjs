import fs from 'node:fs/promises';
import path from 'node:path';
import { readDataset, computeDatasetInputHash } from './benchmark/dataset.mjs';
import { computeCaseInputHash, BENCHMARK_RUNTIME_VERSION } from './benchmark/run.mjs';
import { decodePng } from './png.mjs';
import { atomicWriteJson, canonicalJson, sha256Hex, AppError, REPO_ROOT } from './util.mjs';

const missing = (e) => e.code === 'ENOENT';
async function optionalJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch(e) { if (missing(e)) return null; throw e; } }
async function optionalFile(file) { try { const s=await fs.lstat(file); if(!s.isFile()||s.isSymbolicLink()) throw new AppError('unsafe_path','数据文件类型不正确',422); return await fs.readFile(file); } catch(e) { if(missing(e))return null; throw e; } }
export function createDatasetApi({dataDir, datasetDir=process.env.IMSTAGE_EVAL_DATASET_DIR ?? path.join(REPO_ROOT,'.local/datasets/chat-screenshot-edits-v1'), outDir=path.join(dataDir,'benchmark'), sendJson, readJsonBody}) {
  const reviewsFile=path.join(dataDir,'dataset-reviews.json');
  let queue=Promise.resolve();
  async function context() {
    const dataset=await readDataset(datasetDir);
    const reviews=await optionalJson(reviewsFile) ?? {revision:0,items:{}};
    if(!Number.isInteger(reviews.revision)||!reviews.items)throw new AppError('corrupt_reviews','数据集标注文件损坏，请保留原文件并恢复备份。',500);
    return {dataset,reviews};
  }
  async function artifact(c,kind,manifest) {
    if(kind==='source')return await optionalFile(path.join(datasetDir,c.source.file));
    if(!['expected','actual'].includes(kind))throw new AppError('not_found','未知图像类型',404);
    const folder=kind==='actual'?'private':'expected';
    const record=await optionalJson(path.join(outDir,folder,c.id+'.json'));
    if(!record || (kind==='actual' && !['pass','fail'].includes(record.status)))return null;
    if(record.binding?.datasetInputHash!==computeDatasetInputHash(manifest)||record.binding?.caseInputHash!==computeCaseInputHash(c)||record.binding?.runtimeVersion!==BENCHMARK_RUNTIME_VERSION)return null;
    const bytes=await optionalFile(path.join(outDir,folder,c.id+'.png'));
    if(!bytes||record.pngSha256!==sha256Hex(bytes))return null;
    try { const dims=decodePng(bytes);if(dims.width!==c.source.width||dims.height!==c.source.height)return null; } catch{return null;}
    return bytes;
  }
  async function fingerprint(c,kind,manifest) {
    const bytes=await artifact(c,kind,manifest);
    return bytes ? {hash:sha256Hex(canonicalJson({datasetInputHash:computeDatasetInputHash(manifest),case:c,assets:manifest.assets.filter(a=>c.assetIds.includes(a.id)),kind,png:sha256Hex(bytes)})),bytes} : null;
  }
  return async function handle(req,res,url) {
    const p=url.pathname.split('/').filter(Boolean);
    if(p[0]!=='api'||p[1]!=='dataset')return false;
    let ctx;
    try {ctx=await context();}catch(e){if(missing(e))throw new AppError('dataset_missing','尚未配置数据集。请先导入私有评测包。',404);throw e;}
    const {manifest}=ctx.dataset;
    if(req.method==='GET'&&p.length===2){
      const savedReport=await optionalJson(path.join(outDir,'report.json'));
      const report=savedReport?.dataset?.inputHash===ctx.dataset.datasetInputHash?savedReport:null;
      const cases=await Promise.all(manifest.cases.map(async c=>{
        const variants={};
        for(const kind of ['source','expected','actual']){
          const file=await fingerprint(c,kind,manifest);
          const review=ctx.reviews.items[c.id+':'+kind];
          variants[kind]=file?{url:`/api/dataset/${c.id}/image/${kind}?v=${file.hash}`,hash:file.hash,review:review?.hash===file.hash?review:null,staleReview:!!review&&review.hash!==file.hash}:null;
        }
        const savedRun=await optionalJson(path.join(outDir,'private',c.id+'.json'));
        const run=savedRun?.binding?.datasetInputHash===ctx.dataset.datasetInputHash&&savedRun?.binding?.caseInputHash===computeCaseInputHash(c)&&savedRun?.binding?.runtimeVersion===BENCHMARK_RUNTIME_VERSION?savedRun:null;
        return {...c,variants,run:run?{status:run.status,passed:run.passed,score:run.score?.score,scoring:run.score,checks:run.score?.checks,errorCode:run.errorCode,model:run.model,usage:run.usage}:null};
      }));
      sendJson(res,200,{id:manifest.id,version:manifest.version,private:manifest.private,revision:ctx.reviews.revision,cases,report});return true;
    }
    const c=manifest.cases.find(c=>c.id===p[2]);
    if(!c)throw new AppError('not_found','找不到用例',404);
    if(req.method==='GET'&&p[3]==='image'&&p.length===5){
      const bytes=await artifact(c,p[4],manifest);if(!bytes)throw new AppError('not_found','图片尚未生成',404);
      res.writeHead(200,{'Content-Type':p[4]==='source'?c.source.mime:'image/png','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
    }
    if(req.method==='POST'&&p[3]==='review'&&p.length===4){
      const body=await readJsonBody(req,12000);
      if(!['expected','actual'].includes(body.kind)||!['good','bad','golden','clear'].includes(body.verdict)||typeof body.note!=='string'||body.note.length>4000)throw new AppError('invalid_review','标注参数不正确',422);
      if(body.verdict==='bad'&&!body.note.trim())throw new AppError('missing_reason','请留一句需要改进的原因',422);
      const work=async()=>{
        const fresh=await context();const current=fresh.dataset.manifest.cases.find(v=>v.id===c.id);
        if(body.revision!==fresh.reviews.revision)throw new AppError('revision_conflict','标注已更新，请刷新后重试',409);
        const file=await fingerprint(current,body.kind,fresh.dataset.manifest);
        if(!file||body.hash!==file.hash)throw new AppError('artifact_changed','图片或用例已变化，请刷新后重新判断',409);
        const key=c.id+':'+body.kind;const old=fresh.reviews.items[key];
        if(body.verdict==='golden'&&!(old?.hash===file.hash&&old.verdict==='good'))throw new AppError('review_required','请先将这张图片标为好，再确认为金标',422);
        const next=structuredClone(fresh.reviews);next.revision++;
        if(body.verdict==='clear')delete next.items[key];else next.items[key]={hash:file.hash,verdict:body.verdict==='golden'?'good':body.verdict,golden:body.verdict==='golden',note:body.note.trim(),updatedAt:new Date().toISOString()};
        await atomicWriteJson(reviewsFile,next);sendJson(res,200,{revision:next.revision,review:next.items[key]??null});
      };
      const task=queue.then(work,work);queue=task.catch(()=>{});await task;return true;
    }
    throw new AppError('not_found','未知数据集接口',404);
  };
}
