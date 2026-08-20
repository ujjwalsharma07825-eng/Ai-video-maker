import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const FREE_DAILY_CREDITS=8, MAX_IMAGES=6, MAX_BODY_BYTES=60*1024*1024;
export const DB_PATH=path.resolve('server/data/credits.json');
export const FREE_VIDEO_MODEL='minimax/video-01';
export const MULTI_REFERENCE_MODEL='bytedance/seedance-1-lite';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url))), SEP=`${ROOT}${path.sep}`;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
await loadEnv();
const PORT=Number(process.env.PORT||8787); export let PRO_DAILY_CREDITS=Number(process.env.PRO_DAILY_CREDITS||100);
let queue=Promise.resolve(); const lock=task=>{const n=queue.then(task,task);queue=n.catch(()=>{});return n;};
async function loadEnv(){try{const s=await fs.readFile(path.join(ROOT,'.env'),'utf8');for(const l of s.split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith('#')||!t.includes('='))continue;const[k,...v]=t.split('=');if(!process.env[k])process.env[k]=v.join('=').replace(/^['"]|['"]$/g,'');}}catch{}}
const enabled=v=>['1','true','yes','on'].includes(String(v||'').toLowerCase());
async function saveEnv(up){const p=path.join(ROOT,'.env');let lines=[];try{lines=(await fs.readFile(p,'utf8')).split(/\r?\n/);}catch{}const seen=new Set();lines=lines.map(l=>{const t=l.trim();if(!t||t.startsWith('#')||!t.includes('='))return l;const[k]=t.split('=');if(!(k in up))return l;seen.add(k);return `${k}=${up[k]}`;});for(const[k,v]of Object.entries(up)){if(!seen.has(k))lines.push(`${k}=${v}`);process.env[k]=v;if(k==='PRO_DAILY_CREDITS')PRO_DAILY_CREDITS=Number(v||100);}await fs.writeFile(p,lines.filter(Boolean).join('\n')+'\n');}
const mask=v=>!v?'':v.length<=8?'••••':`${v.slice(0,4)}••••${v.slice(-4)}`;
export const todayKey=(d=new Date())=>d.toISOString().slice(0,10);
export const nextRefreshUtc=(d=new Date())=>`${new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1)).toISOString().slice(0,10)}T00:00:00.000Z`;
export const creditsForPlan=p=>p==='pro'?PRO_DAILY_CREDITS:FREE_DAILY_CREDITS;
async function readDb(){try{return JSON.parse(await fs.readFile(DB_PATH,'utf8'));}catch{return{users:{},jobs:{},orders:{}};}}
async function writeDb(db){await fs.mkdir(path.dirname(DB_PATH),{recursive:true});await fs.writeFile(DB_PATH,JSON.stringify(db,null,2));}
function wallet(db,id){const d=todayKey(),w=db.users[id]||{plan:'free',credits:FREE_DAILY_CREDITS,refreshedAt:d};w.plan||='free';if(w.refreshedAt!==d){w.credits=creditsForPlan(w.plan);w.refreshedAt=d;}db.users[id]=w;return w;}
function send(res,status,body,type='application/json; charset=utf-8'){res.writeHead(status,{'content-type':type,'access-control-allow-origin':'*','access-control-allow-headers':'content-type,x-client-id','access-control-allow-methods':'GET,POST,OPTIONS'});res.end(type.startsWith('application/json')?JSON.stringify(body):body);}
const cid=req=>req.headers['x-client-id']||req.socket.remoteAddress||'anonymous';
async function body(req){const a=[];let n=0;for await(const c of req){n+=c.length;if(n>MAX_BODY_BYTES)throw Object.assign(new Error('Upload is too large. Maximum request size is 60 MB.'),{status:413});a.push(c);}return Buffer.concat(a);}
function multipart(buf,ct){const m=ct.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/),b=m?.[1]||m?.[2];if(!b)return{fields:{},files:[]};const fields={},files=[];for(const part of buf.toString('binary').split(`--${b}`).slice(1,-1)){const[h,x='']=part.replace(/^\r\n/,'').split('\r\n\r\n'),name=h.match(/name="([^"]+)"/)?.[1];if(!name)continue;const fn=h.match(/filename="([^"]*)"/)?.[1],content=x.replace(/\r\n$/,'');if(fn)files.push({name,filename:fn,mimetype:h.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]||'application/octet-stream',buffer:Buffer.from(content,'binary')});else fields[name]=Buffer.from(content,'binary').toString('utf8');}return{fields,files:files.slice(0,MAX_IMAGES)};}
const dataUri=f=>`data:${f.mimetype};base64,${f.buffer.toString('base64')}`;
const clean=p=>({id:p.id,status:p.status,output:p.output,error:p.error,urls:p.urls,created_at:p.created_at,completed_at:p.completed_at});
const model=()=>enabled(process.env.ALLOW_PAID_MODELS)&&process.env.REPLICATE_VIDEO_MODEL?process.env.REPLICATE_VIDEO_MODEL.trim():FREE_VIDEO_MODEL;

function enhancePrompt(text,{mode='text',duration=5,aspectRatio='16:9'}={}){
  const clean=String(text||'').trim().replace(/\s+/g,' '); if(clean.length<8)return clean;
  const camera=/(close[- ]?up|portrait|face|macro)/i.test(clean)?'subtle close-up framing':'smooth cinematic dolly movement';
  const motion=/(walk|run|dance|car|drive|action|fight|chase|fly)/i.test(clean)?'natural subject motion with believable physics':'gentle natural subject motion';
  const light=/(night|dark|sunset|neon|studio)/i.test(clean)?'lighting matched to the described environment':'soft cinematic key light with realistic highlights';
  const people=/(person|people|man|woman|boy|girl|face|couple)/i.test(clean)?'preserve facial identity, anatomy and eye direction, natural expressions':'consistent object shape and fine details';
  return `${clean}. Create a coherent ${duration}-second ${aspectRatio} cinematic shot. ${camera}, ${motion}, ${light}, ${people}. Maintain temporal consistency from first frame to last frame, stable composition, realistic depth, clean edges, natural shadows, premium color grade, high detail. No sudden scene changes, no flicker, no warping, no duplicate subjects, no unwanted text or logos.`;
}

async function replicateCreate(input,requestedModel){
  if(!process.env.REPLICATE_API_TOKEN)throw Object.assign(new Error('REPLICATE_API_TOKEN is required for real AI video generation.'),{status:503});
  const m=requestedModel||model(),v=String(process.env.REPLICATE_VIDEO_VERSION||'').trim(),parts=m.split('/');
  if(!v&&(parts.length!==2||!parts[0]||!parts[1]))throw Object.assign(new Error('Invalid video model slug.'),{status:500});
  const endpoint=v?'https://api.replicate.com/v1/predictions':`https://api.replicate.com/v1/models/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/predictions`;
  const r=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${process.env.REPLICATE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(v?{version:v,input}:{input})}),d=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(d.detail||d.error||`Replicate create failed with ${r.status}`),{status:r.status>=500?502:r.status});
  return{model:v?`${m}@${v}`:m,prediction:d};
}
async function replicateGet(id){const r=await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${process.env.REPLICATE_API_TOKEN}`}}),d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(d.detail||d.error||`Replicate poll failed with ${r.status}`),{status:r.status>=500?502:r.status});return d;}
const plans={starter:{amount:Number(process.env.PRO_STARTER_PRICE||4900),credits:Number(process.env.PRO_STARTER_CREDITS||40),label:'Starter · 40 videos'},creator:{amount:Number(process.env.PRO_CREATOR_PRICE||9900),credits:Number(process.env.PRO_CREATOR_CREDITS||100),label:'Creator · 100 videos'},pro:{amount:Number(process.env.PRO_PRO_PRICE||19900),credits:Number(process.env.PRO_PRO_CREDITS||250),label:'Pro · 250 videos'}};
const paymentReady=()=>Boolean(process.env.RAZORPAY_KEY_ID&&process.env.RAZORPAY_KEY_SECRET);
async function settings(req,res){const setup=enabled(process.env.ALLOW_BROWSER_API_SETUP),base={setupEnabled:setup,replicateConfigured:Boolean(process.env.REPLICATE_API_TOKEN),replicateTokenPreview:mask(process.env.REPLICATE_API_TOKEN),model:model(),freeModel:FREE_VIDEO_MODEL,multiReferenceModel:MULTI_REFERENCE_MODEL,upgradeConfigured:Boolean(process.env.UPGRADE_ACCESS_CODE),proDailyCredits:PRO_DAILY_CREDITS,paymentConfigured:paymentReady(),paymentKeyId:process.env.RAZORPAY_KEY_ID||'',paymentPlans:Object.fromEntries(Object.entries(plans).map(([k,v])=>[k,{amount:v.amount,credits:v.credits,label:v.label}]))};if(req.method==='GET')return send(res,200,base);if(!setup)return send(res,403,{error:'Browser API setup is disabled.'});const b=JSON.parse((await body(req)).toString()||'{}');if(process.env.SETUP_ADMIN_PIN&&b.adminPin!==process.env.SETUP_ADMIN_PIN)return send(res,403,{error:'Invalid admin PIN.'});const up={};for(const[k,e]of [['replicateToken','REPLICATE_API_TOKEN'],['model','REPLICATE_VIDEO_MODEL'],['version','REPLICATE_VIDEO_VERSION'],['upgradeCode','UPGRADE_ACCESS_CODE']])if(b[k])up[e]=String(b[k]).trim();if(b.proDailyCredits)up.PRO_DAILY_CREDITS=String(Number(b.proDailyCredits));if(!Object.keys(up).length)return send(res,400,{error:'No settings were provided.'});await saveEnv(up);return send(res,200,{...base,replicateConfigured:Boolean(process.env.REPLICATE_API_TOKEN),replicateTokenPreview:mask(process.env.REPLICATE_API_TOKEN),model:model(),proDailyCredits:PRO_DAILY_CREDITS,upgradeConfigured:Boolean(process.env.UPGRADE_ACCESS_CODE)});}
async function upgrade(req,res){const b=JSON.parse((await body(req)).toString()||'{}');if(!process.env.UPGRADE_ACCESS_CODE)return send(res,501,{error:'Upgrade code is not configured.'});if(b.code!==process.env.UPGRADE_ACCESS_CODE)return send(res,403,{error:'Invalid upgrade code.'});const w=await lock(async()=>{const db=await readDb(),x=wallet(db,cid(req));x.plan='pro';x.credits=Math.max(x.credits,PRO_DAILY_CREDITS);await writeDb(db);return{...x};});send(res,200,{...w,dailyCredits:creditsForPlan(w.plan),nextRefreshUtc:nextRefreshUtc()});}
async function order(req,res){if(!paymentReady())return send(res,503,{error:'Online payment is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Render environment variables.'});const b=JSON.parse((await body(req)).toString()||'{}'),p=plans[b.plan];if(!p)return send(res,400,{error:'Invalid payment plan.'});const receipt=`avm_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,r=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,'Content-Type':'application/json'},body:JSON.stringify({amount:p.amount,currency:'INR',receipt,capture:'automatic',notes:{plan:b.plan,clientId:cid(req)}})}),d=await r.json().catch(()=>({}));if(!r.ok)return send(res,r.status>=500?502:400,{error:d.error?.description||'Could not create payment order.'});await lock(async()=>{const db=await readDb();db.orders??={};db.orders[d.id]={clientId:cid(req),plan:b.plan,credits:p.credits,status:'created',createdAt:new Date().toISOString()};await writeDb(db);});send(res,200,{keyId:process.env.RAZORPAY_KEY_ID,orderId:d.id,amount:p.amount,currency:'INR',plan:b.plan,label:p.label});}
async function verify(req,res){if(!paymentReady())return send(res,503,{error:'Online payment is not configured.'});const b=JSON.parse((await body(req)).toString()||'{}'),db=await readDb(),o=db.orders?.[b.razorpay_order_id];if(!o||o.clientId!==cid(req))return send(res,400,{error:'Payment order not found.'});const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(`${b.razorpay_order_id}|${b.razorpay_payment_id}`).digest('hex');if(expected!==b.razorpay_signature)return send(res,400,{error:'Payment verification failed.'});if(o.status==='paid')return send(res,200,{ok:true,alreadyProcessed:true});const w=await lock(async()=>{const db2=await readDb(),x=wallet(db2,cid(req));x.plan='pro';x.credits=Math.max(x.credits,o.credits);o.status='paid';o.paymentId=b.razorpay_payment_id;o.paidAt=new Date().toISOString();db2.orders[b.razorpay_order_id]=o;await writeDb(db2);return{...x};});send(res,200,{ok:true,wallet:w,dailyCredits:creditsForPlan(w.plan),nextRefreshUtc:nextRefreshUtc()});}
async function api(req,res,url){
  if(req.method==='OPTIONS')return send(res,204,{});
  if(url.pathname==='/api/health')return send(res,200,{ok:true,provider:'replicate',model:model(),multiReferenceModel:MULTI_REFERENCE_MODEL,configured:Boolean(process.env.REPLICATE_API_TOKEN),freeDailyCredits:FREE_DAILY_CREDITS,proDailyCredits:PRO_DAILY_CREDITS,paymentConfigured:paymentReady()});
  if(url.pathname==='/api/credits'){const w=await lock(async()=>{const db=await readDb(),x=wallet(db,cid(req));await writeDb(db);return{...x};});return send(res,200,{...w,dailyCredits:creditsForPlan(w.plan),nextRefreshUtc:nextRefreshUtc()});}
  if(url.pathname==='/api/settings'&&(req.method==='GET'||req.method==='POST'))return settings(req,res);
  if(url.pathname==='/api/upgrade'&&req.method==='POST')return upgrade(req,res);
  if(url.pathname==='/api/prompt-enhance'&&req.method==='POST'){const b=JSON.parse((await body(req)).toString()||'{}');return send(res,200,{enhanced:enhancePrompt(b.prompt,{mode:b.mode,duration:Number(b.duration||5),aspectRatio:b.aspectRatio||'16:9'}),original:String(b.prompt||'')});}
  if(url.pathname==='/api/payment/order'&&req.method==='POST')return order(req,res);
  if(url.pathname==='/api/payment/verify'&&req.method==='POST')return verify(req,res);
  if(url.pathname==='/api/generate-video'&&req.method==='POST'){
    const p=multipart(await body(req),req.headers['content-type']||''),raw=String(p.fields.prompt||'').trim();
    if(raw.length<12)return send(res,400,{error:'Prompt must be at least 12 characters.'});
    const enhanced=String(p.fields.enhancedPrompt||'').trim()||enhancePrompt(raw,{mode:p.fields.mode,duration:Number(p.fields.duration||5),aspectRatio:p.fields.aspectRatio||'16:9'});
    const imgs=p.files.map(dataUri); const duration=Math.min(12,Math.max(3,Number(p.fields.duration||5))); const aspect=p.fields.aspectRatio||'16:9';
    if(imgs.length>4)return send(res,400,{error:'Multi-image reference mode supports up to 4 images with the current provider. Please select 1–4 reference images.'});
    const input={prompt:enhanced,prompt_optimizer:true};
    let requestedModel=model();
    if(imgs.length>1){
      // MiniMax video-01 accepts only one first_frame_image OR one subject_reference.
      // For true multi-image reference generation, automatically route to Seedance 1 Lite.
      requestedModel=MULTI_REFERENCE_MODEL;
      input.reference_images=imgs;
      input.duration=duration;
      input.resolution='720p';
      input.aspect_ratio=aspect;
      input.camera_fixed=false;
    } else if(imgs.length===1){
      if(p.fields.mode==='image')input.first_frame_image=imgs[0]; else input.subject_reference=imgs[0];
    } else {
      input.duration=duration;
      input.aspect_ratio=aspect;
    }
    if(p.fields.negativePrompt)input.negative_prompt=String(p.fields.negativePrompt);
    const reservation=await lock(async()=>{const db=await readDb(),w=wallet(db,cid(req));if(w.credits<1)return{exhausted:true,wallet:{...w}};w.credits--;const id=crypto.randomUUID();db.jobs[id]={providerId:null,status:'creating',model:null,prompt:raw,enhancedPrompt:enhanced,referenceCount:imgs.length,createdAt:new Date().toISOString(),clientId:cid(req),creditRefunded:false};await writeDb(db);return{localId:id,wallet:{...w}};});
    if(reservation.exhausted)return send(res,402,{error:'Daily free credits exhausted. Wait until 00:00 UTC for refresh.',wallet:reservation.wallet});
    try{const{model:m,prediction}=await replicateCreate(input,requestedModel);await lock(async()=>{const db=await readDb(),j=db.jobs[reservation.localId];if(j){j.providerId=prediction.id;j.model=m;j.status=prediction.status||'starting';}await writeDb(db);});return send(res,200,{jobId:reservation.localId,prediction:clean(prediction),wallet:reservation.wallet,provider:m,referenceCount:imgs.length});}
    catch(e){await lock(async()=>{const db=await readDb();delete db.jobs[reservation.localId];const w=wallet(db,cid(req));w.credits=Math.min(creditsForPlan(w.plan),w.credits+1);await writeDb(db);});return send(res,e.status||502,{error:e.message||'Video provider failed.'});}
  }
  const match=url.pathname.match(/^\/api\/jobs\/([^/]+)$/);if(match){const db=await readDb(),j=db.jobs[match[1]];if(!j)return send(res,404,{error:'Job not found.'});if(!j.providerId)return send(res,202,{job:j,prediction:{status:'starting'}});try{const pr=await replicateGet(j.providerId),terminal=['succeeded','failed','canceled'].includes(pr.status);if(terminal&&pr.status!=='succeeded'&&!j.creditRefunded)await lock(async()=>{const d=await readDb(),x=wallet(d,j.clientId);x.credits=Math.min(creditsForPlan(x.plan),x.credits+1);d.jobs[match[1]].creditRefunded=true;await writeDb(d);});return send(res,200,{job:{...j,status:pr.status},prediction:clean(pr)});}catch(e){return send(res,e.status||502,{error:e.message});}}
  return send(res,404,{error:'Not found'});
}
async function staticFile(res,p){const reqp=p==='/'?'/index.html':p,file=path.normalize(path.join(ROOT,reqp));if(file!==ROOT&&!file.startsWith(SEP))return send(res,403,'Forbidden','text/plain');try{send(res,200,await fs.readFile(file),MIME[path.extname(file)]||'application/octet-stream');}catch{send(res,404,'Not found','text/plain');}}
export const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host}`);if(u.pathname.startsWith('/api/'))return await api(req,res,u);return await staticFile(res,u.pathname);}catch(e){send(res,e.status||500,{error:e.message||'Internal server error'});}});
if(process.argv[1]===fileURLToPath(import.meta.url))server.listen(PORT,()=>console.log(`AI video maker running on http://localhost:${PORT}`));