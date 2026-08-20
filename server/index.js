import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const FREE_DAILY_CREDITS=8;
export const MAX_IMAGES=6;
export const MAX_BODY_BYTES=60*1024*1024;
export const DB_PATH=path.resolve('server/data/credits.json');
export const FREE_VIDEO_MODEL='minimax/video-01';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT_SEP=`${ROOT}${path.sep}`;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
await loadEnv();
const PORT=Number(process.env.PORT||8787);
export let PRO_DAILY_CREDITS=Number(process.env.PRO_DAILY_CREDITS||100);
let dbQueue=Promise.resolve();
function withDbLock(task){const next=dbQueue.then(task,task);dbQueue=next.catch(()=>{});return next;}
async function loadEnv(){try{const s=await fs.readFile(path.join(ROOT,'.env'),'utf8');for(const line of s.split(/\r?\n/)){const t=line.trim();if(!t||t.startsWith('#')||!t.includes('='))continue;const[k,...v]=t.split('=');if(!process.env[k])process.env[k]=v.join('=').replace(/^['"]|['"]$/g,'');}}catch{}}
const enabled=v=>['1','true','yes','on'].includes(String(v||'').toLowerCase());
async function saveEnv(updates){const p=path.join(ROOT,'.env');let lines=[];try{lines=(await fs.readFile(p,'utf8')).split(/\r?\n/);}catch{}const seen=new Set();lines=lines.map(line=>{const t=line.trim();if(!t||t.startsWith('#')||!t.includes('='))return line;const[k]=t.split('=');if(!(k in updates))return line;seen.add(k);return `${k}=${updates[k]}`;});for(const[k,v]of Object.entries(updates)){if(!seen.has(k))lines.push(`${k}=${v}`);process.env[k]=v;if(k==='PRO_DAILY_CREDITS')PRO_DAILY_CREDITS=Number(v||100);}await fs.writeFile(p,lines.filter(Boolean).join('\n')+'\n');}
const mask=v=>!v?'':v.length<=8?'••••':`${v.slice(0,4)}••••${v.slice(-4)}`;
export const todayKey=(d=new Date())=>d.toISOString().slice(0,10);
export const nextRefreshUtc=(d=new Date())=>`${new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1)).toISOString().slice(0,10)}T00:00:00.000Z`;
export const creditsForPlan=p=>p==='pro'?PRO_DAILY_CREDITS:FREE_DAILY_CREDITS;
async function readDb(){try{return JSON.parse(await fs.readFile(DB_PATH,'utf8'));}catch{return{users:{},jobs:{},orders:{}};}}
async function writeDb(db){await fs.mkdir(path.dirname(DB_PATH),{recursive:true});await fs.writeFile(DB_PATH,JSON.stringify(db,null,2));}
function wallet(db,id){const d=todayKey();const w=db.users[id]||{plan:'free',credits:FREE_DAILY_CREDITS,refreshedAt:d};w.plan||='free';if(w.refreshedAt!==d){w.credits=creditsForPlan(w.plan);w.refreshedAt=d;}db.users[id]=w;return w;}
function send(res,status,body,type='application/json; charset=utf-8'){res.writeHead(status,{'content-type':type,'access-control-allow-origin':'*','access-control-allow-headers':'content-type,x-client-id','access-control-allow-methods':'GET,POST,OPTIONS'});res.end(type.startsWith('application/json')?JSON.stringify(body):body);}
const clientId=req=>req.headers['x-client-id']||req.socket.remoteAddress||'anonymous';
async function bodyBuffer(req){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>MAX_BODY_BYTES)throw Object.assign(new Error('Upload is too large. Maximum request size is 60 MB.'),{status:413});chunks.push(c);}return Buffer.concat(chunks);}
function parseMultipart(buffer,contentType){const m=contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/);const boundary=m?.[1]||m?.[2];if(!boundary)return{fields:{},files:[]};const fields={},files=[];for(const part of buffer.toString('binary').split(`--${boundary}`).slice(1,-1)){const[headers,raw='']=part.replace(/^\r\n/,'').split('\r\n\r\n');const name=headers.match(/name="([^"]+)"/)?.[1];if(!name)continue;const filename=headers.match(/filename="([^"]*)"/)?.[1];const content=raw.replace(/\r\n$/,'');if(filename)files.push({name,filename,mimetype:headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]||'application/octet-stream',buffer:Buffer.from(content,'binary')});else fields[name]=Buffer.from(content,'binary').toString('utf8');}return{fields,files:files.slice(0,MAX_IMAGES)};}
const dataUri=(buffer,mime='image/jpeg')=>`data:${mime};base64,${buffer.toString('base64')}`;
const clean=p=>({id:p.id,status:p.status,output:p.output,error:p.error,urls:p.urls,created_at:p.created_at,completed_at:p.completed_at});
const selectedModel=()=>enabled(process.env.ALLOW_PAID_MODELS)&&process.env.REPLICATE_VIDEO_MODEL?process.env.REPLICATE_VIDEO_MODEL.trim():FREE_VIDEO_MODEL;
function enhancePrompt(text,{duration=5,aspectRatio='16:9'}={}){const clean=String(text||'').trim().replace(/\s+/g,' ');if(clean.length<8)return clean;const camera=/(close[- ]?up|portrait|face|macro)/i.test(clean)?'subtle close-up framing':'smooth cinematic dolly movement';const motion=/(walk|run|dance|car|drive|action|fight|chase|fly)/i.test(clean)?'natural subject motion with believable physics':'gentle natural subject motion';const light=/(night|dark|sunset|neon|studio)/i.test(clean)?'lighting matched to the described environment':'soft cinematic key light with realistic highlights';const people=/(person|people|man|woman|boy|girl|face|couple)/i.test(clean)?'preserve facial identity, anatomy and eye direction, natural expressions':'consistent object shape and fine details';return `${clean}. Create a coherent ${duration}-second ${aspectRatio} cinematic shot. ${camera}, ${motion}, ${light}, ${people}. Maintain temporal consistency from first frame to last frame, stable composition, realistic depth, clean edges, natural shadows, premium color grade, high detail. No sudden scene changes, no flicker, no warping, no duplicate subjects, no unwanted text or logos.`;}

async function buildMultiReferenceFrame(files,aspectRatio='16:9'){
  if(files.length<2)return null;
  const ratio=aspectRatio==='9:16'?9/16:aspectRatio==='1:1'?1:16/9;
  const targetW=aspectRatio==='9:16'?720:1280;
  const targetH=Math.round(targetW/ratio);
  const cols=2;
  const rows=Math.ceil(files.length/cols);
  const gap=12;
  const cellW=Math.floor((targetW-gap*(cols-1))/cols);
  const cellH=Math.floor((targetH-gap*(rows-1))/rows);
  const composites=[];
  for(let i=0;i<files.length;i++){
    const b=await sharp(files[i].buffer).rotate().resize(cellW,cellH,{fit:'cover',position:'centre'}).jpeg({quality:88}).toBuffer();
    composites.push({input:b,left:(i%cols)*(cellW+gap),top:Math.floor(i/cols)*(cellH+gap)});
  }
  return sharp({create:{width:targetW,height:targetH,channels:3,background:{r:18,g:18,b:18}}}).composite(composites).jpeg({quality:90}).toBuffer();
}
async function replicateCreate(input){
  if(!process.env.REPLICATE_API_TOKEN)throw Object.assign(new Error('REPLICATE_API_TOKEN is required for real AI video generation.'),{status:503});
  const model=selectedModel();const version=String(process.env.REPLICATE_VIDEO_VERSION||'').trim();const parts=model.split('/');
  if(!version&&(parts.length!==2||!parts[0]||!parts[1]))throw Object.assign(new Error('Invalid video model slug.'),{status:500});
  const endpoint=version?'https://api.replicate.com/v1/predictions':`https://api.replicate.com/v1/models/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/predictions`;
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${process.env.REPLICATE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(version?{version,input}:{input})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(data.detail||data.error||`Replicate create failed with ${response.status}`),{status:response.status>=500?502:response.status});
  return{model:version?`${model}@${version}`:model,prediction:data};
}
async function replicateGet(id){const response=await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${process.env.REPLICATE_API_TOKEN}`}});const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.detail||data.error||`Replicate poll failed with ${response.status}`),{status:response.status>=500?502:response.status});return data;}
const plans={starter:{amount:Number(process.env.PRO_STARTER_PRICE||4900),credits:Number(process.env.PRO_STARTER_CREDITS||40),label:'Starter · 40 videos'},creator:{amount:Number(process.env.PRO_CREATOR_PRICE||9900),credits:Number(process.env.PRO_CREATOR_CREDITS||100),label:'Creator · 100 videos'},pro:{amount:Number(process.env.PRO_PRO_PRICE||19900),credits:Number(process.env.PRO_PRO_CREDITS||250),label:'Pro · 250 videos'}};
const paymentReady=()=>Boolean(process.env.RAZORPAY_KEY_ID&&process.env.RAZORPAY_KEY_SECRET);
async function handleSettings(req,res){const setup=enabled(process.env.ALLOW_BROWSER_API_SETUP);const base={setupEnabled:setup,replicateConfigured:Boolean(process.env.REPLICATE_API_TOKEN),replicateTokenPreview:mask(process.env.REPLICATE_API_TOKEN),model:selectedModel(),freeModel:FREE_VIDEO_MODEL,upgradeConfigured:Boolean(process.env.UPGRADE_ACCESS_CODE),proDailyCredits:PRO_DAILY_CREDITS,paymentConfigured:paymentReady(),paymentKeyId:process.env.RAZORPAY_KEY_ID||'',paymentPlans:Object.fromEntries(Object.entries(plans).map(([k,v])=>[k,{amount:v.amount,credits:v.credits,label:v.label}]))};if(req.method==='GET')return send(res,200,base);if(!setup)return send(res,403,{error:'Browser API setup is disabled.'});const b=JSON.parse((await bodyBuffer(req)).toString()||'{}');if(process.env.SETUP_ADMIN_PIN&&b.adminPin!==process.env.SETUP_ADMIN_PIN)return send(res,403,{error:'Invalid admin PIN.'});const updates={};if(b.replicateToken)updates.REPLICATE_API_TOKEN=String(b.replicateToken).trim();if(b.model)updates.REPLICATE_VIDEO_MODEL=String(b.model).trim();if(b.version)updates.REPLICATE_VIDEO_VERSION=String(b.version).trim();if(b.upgradeCode)updates.UPGRADE_ACCESS_CODE=String(b.upgradeCode).trim();if(b.proDailyCredits)updates.PRO_DAILY_CREDITS=String(Number(b.proDailyCredits));if(!Object.keys(updates).length)return send(res,400,{error:'No settings were provided.'});await saveEnv(updates);return send(res,200,{...base,replicateConfigured:Boolean(process.env.REPLICATE_API_TOKEN),replicateTokenPreview:mask(process.env.REPLICATE_API_TOKEN),model:selectedModel(),proDailyCredits:PRO_DAILY_CREDITS,upgradeConfigured:Boolean(process.env.UPGRADE_ACCESS_CODE)});}
async function handleUpgrade(req,res){const b=JSON.parse((await bodyBuffer(req)).toString()||'{}');if(!process.env.UPGRADE_ACCESS_CODE)return send(res,501,{error:'Upgrade code is not configured.'});if(b.code!==process.env.UPGRADE_ACCESS_CODE)return send(res,403,{error:'Invalid upgrade code.'});const w=await withDbLock(async()=>{const db=await readDb();const x=wallet(db,clientId(req));x.plan='pro';x.credits=Math.max(x.credits,PRO_DAILY_CREDITS);await writeDb(db);return{...x};});return send(res,200,{...w,dailyCredits:creditsForPlan(w.plan),nextRefreshUtc:nextRefreshUtc()});}
async function handleOrder(req,res){if(!paymentReady())return send(res,503,{error:'Online payment is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Render environment variables.'});const b=JSON.parse((await bodyBuffer(req)).toString()||'{}'),plan=plans[b.plan];if(!plan)return send(res,400,{error:'Invalid payment plan.'});const receipt=`avm_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;const response=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,'Content-Type':'application/json'},body:JSON.stringify({amount:plan.amount,currency:'INR',receipt,capture:'automatic',notes:{plan:b.plan,clientId:clientId(req)}})});const data=await response.json().catch(()=>({}));if(!response.ok)return send(res,response.status>=500?502:400,{error:data.error?.description||'Could not create payment order.'});await withDbLock(async()=>{const db=await readDb();db.orders??={};db.orders[data.id]={clientId:clientId(req),plan:b.plan,credits:plan.credits,status:'created',createdAt:new Date().toISOString()};await writeDb(db);});return send(res,200,{keyId:process.env.RAZORPAY_KEY_ID,orderId:data.id,amount:plan.amount,currency:'INR',plan:b.plan,label:plan.label});}
async function handleVerify(req,res){if(!paymentReady())return send(res,503,{error:'Online payment is not configured.'});const b=JSON.parse((await bodyBuffer(req)).toString()||'{}');const db=await readDb();const order=db.orders?.[b.razorpay_order_id];if(!order||order.clientId!==clientId(req))return send(res,400,{error:'Payment order not found.'});const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(`${b.razorpay_order_id}|${b.razorpay_payment_id}`).digest('hex');if(expected!==b.razorpay_signature)return send(res,400,{error:'Payment verification failed.'});if(order.status==='paid')return send(res,200,{ok:true,alreadyProcessed:true});const w=await withDbLock(async()=>{const db2=await readDb();const x=wallet(db2,clientId(req));x.plan='pro';x.credits=Math.max(x.credits,order.credits);order.status='paid';order.paymentId=b.razorpay_payment_id;order.paidAt=new Date().toISOString();db2.orders[b.razorpay_order_id]=order;await writeDb(db2);return{...x};});return send(res,200,{ok:true,wallet:w,dailyCredits:creditsForPlan(w.plan),nextRefreshUtc:nextRefreshUtc()});}
async function handleGenerate(req,res){
  const parsed=parseMultipart(await bodyBuffer(req),req.headers['content-type']||'');
  const prompt=String(parsed.fields.prompt||'').trim();
  if(prompt.length<12)return send(res,400,{error:'Prompt must be at least 12 characters.'});
  const files=parsed.files.filter(f=>/^image\//i.test(f.mimetype));
  if(files.length>4)return send(res,400,{error:'You can use up to 4 reference images.'});
  const duration=Math.min(10,Math.max(5,Number(parsed.fields.duration||5)));
  const aspectRatio=parsed.fields.aspectRatio||'16:9';
  const enhancedPrompt=String(parsed.fields.enhancedPrompt||'').trim()||enhancePrompt(prompt,{duration,aspectRatio});
  let referenceBuffer=null;
  try{
    if(files.length>1)referenceBuffer=await buildMultiReferenceFrame(files,aspectRatio);
    else if(files.length===1)referenceBuffer=await sharp(files[0].buffer).rotate().jpeg({quality:90}).toBuffer();
  }catch(e){return send(res,400,{error:`Reference image preparation failed: ${e.message}`});}
  const reservation=await withDbLock(async()=>{const db=await readDb();const w=wallet(db,clientId(req));if(w.credits<1)return{exhausted:true,wallet:{...w}};w.credits--;const id=crypto.randomUUID();db.jobs[id]={providerId:null,status:'creating',model:null,prompt,enhancedPrompt,referenceCount:files.length,referenceMode:files.length>1?'multi-image-composite':files.length===1?'single-image':'none',createdAt:new Date().toISOString(),clientId:clientId(req),creditRefunded:false};await writeDb(db);return{localId:id,wallet:{...w}};});
  if(reservation.exhausted)return send(res,402,{error:'Daily free credits exhausted. Wait until 00:00 UTC for refresh.',wallet:reservation.wallet});
  try{
    const input={prompt:enhancedPrompt,duration,aspect_ratio:aspectRatio,negative_prompt:parsed.fields.negativePrompt||'low quality, blurry, warped faces, flicker, text artifacts'};
    if(referenceBuffer)input.first_frame_image=dataUri(referenceBuffer,'image/jpeg');
    const {model,prediction}=await replicateCreate(input);
    await withDbLock(async()=>{const db=await readDb();const job=db.jobs[reservation.localId];if(job){job.providerId=prediction.id;job.model=model;job.status=prediction.status||'starting';}await writeDb(db);});
    return send(res,200,{jobId:reservation.localId,prediction:clean(prediction),wallet:reservation.wallet,provider:model,referenceCount:files.length,referenceMode:files.length>1?'multi-image-composite':files.length===1?'single-image':'none'});
  }catch(error){
    await withDbLock(async()=>{const db=await readDb();delete db.jobs[reservation.localId];const w=wallet(db,clientId(req));w.credits=Math.min(creditsForPlan(w.plan),w.credits+1);await writeDb(db);});
    const message=String(error.message||'Video provider failed.');
    const status=/insufficient credit|billing|payment method|rate limit/i.test(message)?402:(error.status||502);
    return send(res,status,{error:message,creditRefunded:true});
  }
}
async function handleJob(req,res,id){const db=await readDb();const job=db.jobs[id];if(!job)return send(res,404,{error:'Job not found.'});if(!job.providerId)return send(res,202,{job,prediction:{status:'starting'}});try{const prediction=await replicateGet(job.providerId);const terminal=['succeeded','failed','canceled'].includes(prediction.status);if(terminal&&prediction.status!=='succeeded'&&!job.creditRefunded){await withDbLock(async()=>{const d=await readDb();const w=wallet(d,job.clientId);w.credits=Math.min(creditsForPlan(w.plan),w.credits+1);if(d.jobs[id])d.jobs[id].creditRefunded=true;await writeDb(d);});job.creditRefunded=true;}return send(res,200,{job,prediction:clean(prediction)});}catch(error){return send(res,error.status||502,{error:error.message});}}
async function handleApi(req,res,url){if(req.method==='OPTIONS')return send(res,204,{});if(url.pathname==='/api/health')return send(res,200,{ok:true,provider:'replicate',model:selectedModel(),configured:Boolean(process.env.REPLICATE_API_TOKEN),freeDailyCredits:FREE_DAILY_CREDITS,proDailyCredits:PRO_DAILY_CREDITS,paymentConfigured:paymentReady(),multiImageSupport:true,multiImageMode:'local-composite-to-first-frame'});if(url.pathname==='/api/credits'){const w=await withDbLock(async()=>{const db=await readDb();const x=wallet(db,clientId(req));await writeDb(db);return{...x};});return send(res,200,{...w,dailyCredits:creditsForPlan(w.plan),nextRefreshUtc:nextRefreshUtc()});}if(url.pathname==='/api/settings'&&(req.method==='GET'||req.method==='POST'))return handleSettings(req,res);if(url.pathname==='/api/upgrade'&&req.method==='POST')return handleUpgrade(req,res);if(url.pathname==='/api/payment/order'&&req.method==='POST')return handleOrder(req,res);if(url.pathname==='/api/payment/verify'&&req.method==='POST')return handleVerify(req,res);if(url.pathname==='/api/prompt-enhance'&&req.method==='POST'){const b=JSON.parse((await bodyBuffer(req)).toString()||'{}');return send(res,200,{enhanced:enhancePrompt(b.prompt,{duration:Number(b.duration||5),aspectRatio:b.aspectRatio||'16:9'}),original:String(b.prompt||'')});}if(url.pathname==='/api/generate-video'&&req.method==='POST')return handleGenerate(req,res);const match=url.pathname.match(/^\/api\/jobs\/([^/]+)$/);if(match)return handleJob(req,res,match[1]);return send(res,404,{error:'Not found'});}
async function serveStatic(res,pathname){const requested=pathname==='/'?'/index.html':pathname;const file=path.normalize(path.join(ROOT,requested));if(file!==ROOT&&!file.startsWith(ROOT_SEP))return send(res,403,'Forbidden','text/plain');try{send(res,200,await fs.readFile(file),MIME[path.extname(file)]||'application/octet-stream');}catch{send(res,404,'Not found','text/plain');}}
export const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host}`);if(url.pathname.startsWith('/api/'))return await handleApi(req,res,url);return await serveStatic(res,url.pathname);}catch(error){send(res,error.status||500,{error:error.message||'Internal server error'});}});
if(process.argv[1]===fileURLToPath(import.meta.url))server.listen(PORT,()=>console.log(`AI video maker running on http://localhost:${PORT}`));
