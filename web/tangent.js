import * as THREE from '/vendor/three.module.js';
const V=THREE.Vector3,cl=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),sm=(a,b,x)=>{const t=cl((x-a)/(b-a));return t*t*(3-2*t)},win=(p,c,r)=>1-sm(r*.5,r,Math.abs(p-c));
const rnd=(s=>()=>{s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296})(11);
const PAGE=JSON.parse(document.getElementById('page').textContent),READ=PAGE.mode==='read',SEQ=PAGE.seq||[0,1,2,3,4,5],NS=SEQ.length,WORD=PAGE.word;
try{await Promise.race([Promise.all([document.fonts.load('700 80px Inter',WORD),document.fonts.load('600 80px Inter','Run a node')]),new Promise(r=>setTimeout(r,3500))])}catch(e){}
if(!READ)document.querySelector('main').style.height=(164*(NS-1))+'vh';
let mob=innerWidth<820,wide=innerWidth>=1000;const MS=1.45;

/* the word, sampled into nodes */
const COLS=Math.round(74*WORD.length/7),wc=document.createElement('canvas'),wx=wc.getContext('2d');
wx.font='700 100px Inter';wx.letterSpacing='7px';const tw=wx.measureText(WORD).width,th=73;
const ROWS=Math.round(COLS*th/tw)+2;wc.width=COLS;wc.height=ROWS;const wsc=(COLS-2)/tw;
wx.setTransform(wsc,0,0,wsc,1,1);wx.font='700 100px Inter';wx.letterSpacing='7px';wx.fillStyle='#000';wx.fillText(WORD,0,th);
const wd=wx.getImageData(0,0,COLS,ROWS).data,cells=[],cellId=new Map();
for(let c=0;c<COLS;c++)for(let r=0;r<ROWS;r++)if(wd[(r*COLS+c)*4+3]>105){cellId.set(r*COLS+c,cells.length);cells.push([c,r])}
const M0=cells.length,LW=(mob?14.5:30)*Math.max(.72,WORD.length/7),CELL=LW/COLS;

/* the network those same nodes fly out to */
const P=[];let guard=0;
while(P.length<M0&&guard++<400000){const v=new V((rnd()*2-1)*19,(rnd()*2-1)*6.5,(rnd()*2-1)*12);if(v.x*v.x/361+v.y*v.y/42.25+v.z*v.z/144>1)continue;if(P.some(q=>q.distanceToSquared(v)<3.2))continue;P.push(v)}
P.sort((a,b)=>a.x-b.x);
const Lp=cells.map(([c,r])=>new V((c-COLS/2+.5)*CELL,-(r-ROWS/2+.5)*CELL,(rnd()-.5)*1.1));
const HL=[];cells.forEach(([c,r],i)=>{const a=cellId.get(r*COLS+c+1),b=cellId.get((r+1)*COLS+c);if(a!==undefined&&c+1<COLS)HL.push([i,a]);if(b!==undefined)HL.push([i,b])});
const L=[],keys=new Set();function link(a,b){const k=a<b?a+'_'+b:b+'_'+a;if(a===b||keys.has(k))return;keys.add(k);L.push([a,b])}
P.forEach((p,i)=>{const o=[];for(let j=0;j<M0;j++)if(j!==i)o.push([p.distanceToSquared(P[j]),j]);o.sort((x,y)=>x[0]-y[0]);link(i,o[0][1]);link(i,o[1][1]);if(rnd()<.28)link(i,o[2][1])});
let n0=0;P.forEach((p,i)=>{if(p.distanceTo(new V(0,0,3))<P[n0].distanceTo(new V(0,0,3)))n0=i});
function bfs(){const d=new Array(M0).fill(-1),par=new Array(M0).fill(-1),adj=P.map(()=>[]);L.forEach(([a,b])=>{adj[a].push(b);adj[b].push(a)});d[n0]=0;const q=[n0];while(q.length){const a=q.shift();for(const b of adj[a])if(d[b]<0){d[b]=d[a]+1;par[b]=a;q.push(b)}}return{d,par}}
let g=bfs();
while(g.d.includes(-1)){let best=[1e9,0,0];for(let a=0;a<M0;a++){if(g.d[a]<0)continue;for(let b=0;b<M0;b++){if(g.d[b]>=0)continue;const x=P[a].distanceToSquared(P[b]);if(x<best[0])best=[x,a,b]}}link(best[1],best[2]);g=bfs()}
const D=g.d,PAR=g.par,maxD=Math.max(...D),dl=P.map(()=>rnd());
/* private route */
let rs=n0,bs=-1e9;for(let i=0;i<M0;i++){if(D[i]<4)continue;const q=[i,PAR[i],PAR[PAR[i]],PAR[PAR[PAR[i]]]].map(j=>P[j]),ys=q.map(v=>v.y),hs=Math.hypot(q[3].x-q[0].x,q[3].z-q[0].z),s=hs-2.6*(Math.max(...ys)-Math.min(...ys))+P[i].z*.15;if(s>bs){bs=s;rs=i}}
const ROUTE=[rs,PAR[rs],PAR[PAR[rs]],PAR[PAR[PAR[rs]]]];
/* off grid devices, past the edge of the network */
let gw=0;for(let i=1;i<M0;i++)if(P[i].x-P[i].z*.35<P[gw].x-P[gw].z*.35)gw=i;
const CH=[];for(let k=4;k>=0;k--){P.push(P[gw].clone().add(new V(-2.1*(k+1),-.35*(k+1)+(k%2?.7:-.5),1.3*(k+1)+(k%2?-.9:.7))));CH.push(P.length-1)}
CH.push(gw);
for(let k=0;k<7;k++)P.push(P[gw].clone().add(new V(-2-rnd()*10,(rnd()-.5)*5.5,1+rnd()*8-2)));
/* agent computer */
let C=n0,bc=-1e9;for(let i=0;i<M0;i++){if(ROUTE.includes(i)||i===gw||i===n0)continue;const s=P[i].z*1.3-Math.abs(P[i].x+5)-Math.abs(P[i].y)*.6;if(s>bc){bc=s;C=i}}
const M=P.length,cur=P.map(p=>p.clone());

/* scene */
const canvas=document.getElementById('gl'),renderer=new THREE.WebGLRenderer({canvas,antialias:true});
const scene=new THREE.Scene(),cam=new THREE.PerspectiveCamera(36,1,.1,300);
scene.fog=new THREE.Fog(0,14,62);scene.background=new THREE.Color();
const U={uFg:{value:new THREE.Color()},uBg:{value:new THREE.Color()},uAcc:{value:new THREE.Color(0x3d5cff)},uTone:{value:.72},uFog:{value:new THREE.Vector2(14,62)}};
const geo=new THREE.BoxGeometry(.3,.3,.3),aDim=new THREE.InstancedBufferAttribute(new Float32Array(M),1),aAcc=new THREE.InstancedBufferAttribute(new Float32Array(M),1);
geo.setAttribute('aDim',aDim);geo.setAttribute('aAcc',aAcc);
const nodeMat=new THREE.ShaderMaterial({uniforms:U,vertexShader:`attribute float aDim;attribute float aAcc;varying vec3 vC;uniform vec3 uFg;uniform vec3 uBg;uniform vec3 uAcc;uniform float uTone;uniform vec2 uFog;
void main(){float tone=abs(normal.y)>.5?0.:(abs(normal.x)>.5?.4:.66);vec3 mono=mix(uFg,uBg,tone*uTone);vec3 blue=uAcc*(1.-tone*.4);vec3 c=mix(mono,blue,aAcc);c=mix(uBg,c,max(aDim,aAcc));
vec4 mv=modelViewMatrix*instanceMatrix*vec4(position,1.);float f=smoothstep(uFog.x,uFog.y,-mv.z);vC=mix(c,uBg,f*.9);gl_Position=projectionMatrix*mv;}`,
fragmentShader:`varying vec3 vC;void main(){gl_FragColor=vec4(vC,1.);
#include <colorspace_fragment>
}`});
const nodes=new THREE.InstancedMesh(geo,nodeMat,M);nodes.frustumCulled=false;scene.add(nodes);
const rot=P.map(()=>rnd()*Math.PI),dummy=new THREE.Object3D();
const mkLines=(n,mat)=>{const arr=new Float32Array(n*6),ge=new THREE.BufferGeometry();ge.setAttribute('position',new THREE.BufferAttribute(arr,3));const m=new THREE.LineSegments(ge,mat);m.frustumCulled=false;scene.add(m);return{arr,ge,m}};
const lmat=new THREE.LineBasicMaterial({transparent:true}),hmat=new THREE.LineBasicMaterial({transparent:true});
const net=mkLines(L.length,lmat),word=mkLines(HL.length,hmat);
const cmat=new THREE.LineDashedMaterial({transparent:true,opacity:.8,dashSize:.16,gapSize:.13}),chn=mkLines(CH.length-1,cmat),cd=new Float32Array((CH.length-1)*2);chn.ge.setAttribute('lineDistance',new THREE.BufferAttribute(cd,1));
const accMat=new THREE.MeshBasicMaterial({color:0x3d5cff,transparent:true}),coinMat=new THREE.MeshBasicMaterial({color:0x3d5cff,transparent:true});
const tubes=ROUTE.slice(1).map(()=>{const m=new THREE.Mesh(new THREE.CylinderGeometry(.035,.035,1,10),accMat);scene.add(m);return m});
const packet=new THREE.Mesh(new THREE.SphereGeometry(.13,20,14),accMat);scene.add(packet);
const coin=new THREE.Mesh(new THREE.SphereGeometry(.12,20,14),coinMat);scene.add(coin);
const edge=(s,mat)=>{const m=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(s,s,s)),mat);scene.add(m);return m};
const firstMat=new THREE.LineBasicMaterial({transparent:true}),boxFg=new THREE.LineBasicMaterial({transparent:true}),boxAcc=new THREE.LineBasicMaterial({color:0x3d5cff,transparent:true});
const first1=edge(.74,firstMat),first2=edge(1.3,firstMat),comp1=edge(.78,boxFg),comp2=edge(1.35,boxAcc);
[first1,first2].forEach(m=>m.position.copy(P[n0]));[comp1,comp2].forEach(m=>m.position.copy(P[C]));
const ringMat=new THREE.MeshBasicMaterial({color:0x3d5cff,transparent:true,side:THREE.DoubleSide,depthWrite:false}),ring=new THREE.Mesh(new THREE.RingGeometry(.965,1,72),ringMat);scene.add(ring);

/* camera stops */
const mid=a=>a.reduce((s,i)=>s.add(P[i]),new V()).multiplyScalar(1/a.length);
const rdir=P[ROUTE[3]].clone().sub(P[ROUTE[0]]),ro=rdir.clone().cross(new V(0,1,0)).normalize().multiplyScalar(13.5);if(ro.z<0)ro.negate();ro.y=3;
const K=[{f:new V(0,0,0),o:new V(-6,3,37),fog:[30,120]},{f:P[n0].clone(),o:new V(4,5,21),fog:[14,62]},{f:mid(ROUTE),o:ro,fog:[11,50]},{f:mid(CH),o:new V(2.5,3,15),fog:[12,60]},{f:P[C].clone(),o:new V(1.7,1.2,5.4),fog:[8,46]},{f:new V(0,-.5,0),o:new V(-8,10,42),fog:[30,110]}];

/* statements that live inside the scene */
const SAY=[0,1,2,3,4,5].map(k=>(!READ&&SEQ.includes(k)&&PAGE.say&&PAGE.say[k])||null);
const planes=[];
function buildPlanes(){planes.forEach(p=>{scene.remove(p);p.material.map.dispose();p.geometry.dispose()});planes.length=0;
  SAY.forEach((s,i)=>{if(!s)return;const lines=mob?s.m:s.d,c=document.createElement('canvas'),x=c.getContext('2d'),fs=200,font=`600 ${fs}px Inter`;x.font=font;x.letterSpacing='-8px';
    const w=Math.max(...lines.map(l=>x.measureText(l[0]).width)),lh=fs*1.03;c.width=Math.ceil(w)+40;c.height=Math.ceil(lh*lines.length+fs*.3);
    x.font=font;x.letterSpacing='-8px';x.textAlign='center';x.textBaseline='alphabetic';x.fillStyle='#fff';
    lines.forEach((l,k)=>{x.globalAlpha=l[1]?.5:1;x.fillText(l[0],c.width/2,fs*.92+k*lh)});
    const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=8;
    const k=K[i],d=k.o.length()*k.sc+1.2,visH=2*Math.tan(Math.PI/10)*d,visW=visH*(innerWidth/innerHeight),pw=(mob?.84:.56)*visW,ph=pw*c.height/c.width;
    const fw=k.o.clone().normalize().negate(),rt=fw.clone().cross(new V(0,1,0)).normalize(),up=rt.clone().cross(fw);
    const m=new THREE.Mesh(new THREE.PlaneGeometry(pw,ph),new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false}));
    m.position.copy(k.f).addScaledVector(fw,1.2).addScaledVector(up,-(mob?.2:.215)*visH);
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(rt,up,fw.clone().negate()));if(!mob)m.rotateY(i%2?.17:-.17);
    m.userData.k=i;m.renderOrder=2;m.updateMatrixWorld();scene.add(m);planes.push(m)});paint()}

/* labels pinned to nodes */
const LAB=[[n0,'the first node',1],[ROUTE[0],'you',2],[ROUTE[1],'entry',2],[ROUTE[2],'middle',2],[ROUTE[3],'exit to the open web',2],[CH[0],'no signal',3],[gw,'back online',3],[C,'browser, wallet, inbox',4,64]]
 .filter(l=>SEQ.includes(l[2])).map(([n,t,k,dx=10])=>{t=(PAGE.lab&&PAGE.lab[t])||t;const el=document.createElement('div');el.className='lab';el.textContent=t;document.getElementById('labs').appendChild(el);return{n,k,el,dx,w:0,side:0}});
const SUB=[0,1,2,3,4,5].map(k=>(PAGE.sub&&PAGE.sub[k])||''),CMD=[0,1,2,3,4,5].map(k=>(PAGE.cmd&&PAGE.cmd[k])||'');

let fgc='#fff';
function paint(){planes.forEach(p=>p.material.color.set(fgc))}
function theme(t){document.documentElement.dataset.theme=t;const cs=getComputedStyle(document.documentElement),bg=cs.getPropertyValue('--bg').trim();fgc=cs.getPropertyValue('--fg').trim();
  U.uBg.value.set(bg);U.uFg.value.set(fgc);scene.background.set(bg);scene.fog.color.set(bg);[lmat,hmat,cmat,firstMat,boxFg].forEach(m=>m.color.set(fgc));paint();
  lmat.userData.base=t==='light'?.5:.36;U.uTone.value=t==='light'?.46:.72;}
let W=0,H=0;
/* where the camera looks from: journey pages centre the scene, reading pages on a wide screen move it right of the text */
const view=s=>READ?(wide?[-W*.3*s,H*.03]:[0,H*(.12+.1*s)]):[0,H*(mob?.13:.08)];
/* pull the camera back at a stop until its nodes fit the free part of the screen (phones, and the reading column) */
const FIT={2:()=>ROUTE,3:()=>CH},fv=new V();
function fit(){const c=new THREE.PerspectiveCamera(36,W/H,.1,300),[xo,yo]=view(1),lo=READ&&wide?.3:-.7,hi=READ&&wide?.9:.7,ylo=READ&&!wide?-.05:-.78,yhi=READ&&!wide?.8:.78;
  K.forEach((k,i)=>{let s=mob?MS:1;if(FIT[i]&&(mob||READ)){c.setViewOffset(W,H,xo,yo,W,H);for(let it=0;it<40;it++){c.position.copy(k.f).addScaledVector(k.o,s);c.lookAt(k.f);c.updateMatrixWorld();let ok=true;for(const n of FIT[i]()){fv.copy(P[n]).project(c);if(fv.x<lo||fv.x>hi||fv.y<ylo||fv.y>yhi){ok=false;break}}if(ok)break;s*=1.06}}k.sc=s})}
function size(){W=innerWidth;H=innerHeight;mob=W<820;wide=W>=1000;renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(W,H,false);cam.aspect=W/H;cam.updateProjectionMatrix();fit();buildPlanes()}
theme('dark');
addEventListener('resize',size);size();
const mouse={x:-1e4,y:-1e4};addEventListener('pointermove',e=>{if(e.pointerType==='mouse'){mouse.x=e.clientX;mouse.y=e.clientY}});

const AN=READ?[...document.querySelectorAll('[data-k]')].map(el=>({el,k:+el.dataset.k,s:el.dataset.s===undefined?1:+el.dataset.s,t:0})):[],SOLID=[...document.querySelectorAll('.solid')];
let kS=AN.length?AN[0].k:0,sS=AN.length?AN[0].s:0;
/* reading mode: the section at the reading line decides where the camera is (k: stop, s: shift beside the text) */
function readAt(){const max=document.documentElement.scrollHeight-H,y=scrollY,fy=H*(.5*cl(y/(H*.5))+.42*cl(1-(max-y)/(H*.7)));let i=-1;for(let j=0;j<AN.length;j++){AN[j].t=AN[j].el.getBoundingClientRect().top;if(AN[j].t<=fy+.5)i=j}
  if(i<0)return[AN[0].k,AN[0].s];if(i===AN.length-1)return[AN[i].k,AN[i].s];const a=AN[i],b=AN[i+1],u=sm(0,1,(fy-a.t)/Math.max(1,b.t-a.t));return[a.k+(b.k-a.k)*u,a.s+(b.s-a.s)*u]}
const hero=document.getElementById('hero'),cmd=document.getElementById('cmd'),sub=document.getElementById('sub'),act=document.getElementById('act'),segs=[...document.querySelectorAll('#prog i')];
let ps=0,subK=-1;const f=new V(),o=new V(),a=new V(),b=new V(),up=new V(0,1,0),dir=new V(),v=new V();
function frame(ms){const t=ms/1000,ta=READ?t*.35:t;let q=0,p;
  if(READ){const[kT,sT]=readAt();kS+=(kT-kS)*.07;sS+=(sT-sS)*.07;p=cl(kS/5,0,1)}
  else{const pt=cl(scrollY/Math.max(1,document.documentElement.scrollHeight-innerHeight));ps+=(pt-ps)*.09;q=ps;const qx=cl(q*(NS-1),0,NS-1-1e-4),qi=Math.floor(qx);p=(SEQ[qi]+(SEQ[qi+1]-SEQ[qi])*(qx-qi))/5}
  const x=cl(p*5,0,4.9999),i=Math.floor(x),u=sm(0,1,x-i);f.lerpVectors(K[i].f,K[i+1].f,u);o.lerpVectors(K[i].o,K[i+1].o,u);
  const sc=K[i].sc+(K[i+1].sc-K[i].sc)*u,fn=K[i].fog[0]+(K[i+1].fog[0]-K[i].fog[0])*u,ff=K[i].fog[1]+(K[i+1].fog[1]-K[i].fog[1])*u,fk=Math.max(sc,mob?MS:1);U.uFog.value.set(fn*fk,ff*fk);scene.fog.near=fn*fk;scene.fog.far=ff*fk;
  o.multiplyScalar(sc);if(!READ){o.x+=Math.sin(t*.21)*.2;o.y+=Math.cos(t*.17)*.14}
  const[vx,vy]=view(READ?sS:0);cam.position.copy(f).add(o);cam.lookAt(f);cam.setViewOffset(W,H,vx,vy,W,H);cam.updateMatrixWorld();

  const R=sm(.09,.34,p)*(maxD+1.2),a2=win(p,.4,.13),a3=win(p,.6,.13),a4=win(p,.8,.13);
  const rp=sm(.28,.39,p)*(ROUTE.length-1),rfade=1-sm(.47,.53,p),cr=sm(.47,.57,p)*(CH.length-1),offIn=sm(.38,.5,p);
  const cs=(ta*.3)%1*(CH.length-1),holder=Math.min(CH.length-1,Math.round(cs)),chainOn=cr>=CH.length-1-.01;
  const rects=[];planes.forEach(m=>{const op=1-sm(.3,.62,Math.abs(p*5-m.userData.k));if(op<.05)return;const gp=m.geometry.parameters;let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9,z=0;for(const[qx,qy]of[[-1,-1],[1,-1],[-1,1],[1,1]]){v.set(qx*gp.width/2,qy*gp.height/2,0).applyMatrix4(m.matrixWorld).project(cam);const X=(v.x*.5+.5)*W,Y=(-v.y*.5+.5)*H;x0=Math.min(x0,X);x1=Math.max(x1,X);y0=Math.min(y0,Y);y1=Math.max(y1,Y);z+=v.z/4}rects.push([x0-16,x1+16,y0-4,y1+4,z,op])});
  const hush=1-.45*Math.max(a2,a4);
  for(let n=0;n<M;n++){let lit,acc=0,sx=1,sy=1,sz=1,hide=0;
    if(n<M0){const e=sm(.015+.08*dl[n],.12+.08*dl[n],p);cur[n].lerpVectors(Lp[n],P[n],e);lit=Math.max(1-e,n===n0?1:cl((R-(D[n]-.1))*3))}
    else{const ci=CH.indexOf(n);lit=ci>=0?Math.max(.35,cl((cr-ci+1)*3)):.35;sx=.56*1.5*offIn;sy=1.5*offIn;sz=.14*1.5*offIn}
    const ci=CH.indexOf(n);if(ci>=0&&chainOn&&ci===holder)acc=a3;
    const ri=ROUTE.indexOf(n);if(ri>=0)acc=Math.max(acc,cl(rp-ri+1)*rfade*sm(.26,.3,p));
    if(n===C)acc=Math.max(acc,a4);
    v.copy(cur[n]).project(cam);if(v.z<1){const X=(v.x*.5+.5)*W,Y=(-v.y*.5+.5)*H;if(acc<.3)for(const r of rects)if(v.z<r[4])hide=Math.max(hide,r[5]*cl(Math.min(X-r[0],r[1]-X,Y-r[2],r[3]-Y)/28));acc=Math.max(acc,cl(1-Math.hypot(X-mouse.x,Y-mouse.y)/90))}
    aDim.array[n]=.2+.8*lit*hush;aAcc.array[n]=acc;const k=(1-hide)*(n<M0?.74+.26*lit:1)*(1+.45*acc)*(n===n0?1+.4*win(p,.2,.14):1);
    dummy.position.copy(cur[n]);dummy.rotation.set(0,rot[n]*sm(.02,.14,p),n<M0?0:(rot[n]-1.5)*.25);dummy.scale.set(sx*k,sy*k,sz*k);dummy.updateMatrix();nodes.setMatrixAt(n,dummy.matrix)}
  aDim.needsUpdate=aAcc.needsUpdate=true;nodes.instanceMatrix.needsUpdate=true;

  hmat.opacity=(1-sm(.01,.07,p))*.55;word.m.visible=hmat.opacity>.01;
  if(word.m.visible){HL.forEach(([q,r],k)=>{a.copy(cur[q]);b.copy(cur[r]);word.arr.set([a.x,a.y,a.z,b.x,b.y,b.z],k*6)});word.ge.attributes.position.needsUpdate=true}
  L.forEach(([q,r],k)=>{const s=D[q]<=D[r]?q:r,e=s===q?r:q,gg=cl(R-D[s]);a.copy(cur[s]);b.lerpVectors(cur[s],cur[e],gg);net.arr.set([a.x,a.y,a.z,b.x,b.y,b.z],k*6)});
  net.ge.attributes.position.needsUpdate=true;lmat.opacity=lmat.userData.base*(1-.5*Math.max(a2,a3,a4));
  for(let k=0;k<CH.length-1;k++){const gg=cl(cr-k);a.copy(P[CH[k]]);b.lerpVectors(a,P[CH[k+1]],gg);chn.arr.set([a.x,a.y,a.z,b.x,b.y,b.z],k*6);cd[k*2]=0;cd[k*2+1]=a.distanceTo(b)}
  chn.ge.attributes.position.needsUpdate=chn.ge.attributes.lineDistance.needsUpdate=true;

  accMat.opacity=rfade;tubes.forEach((m,k)=>{const gg=cl(rp-k);a.copy(P[ROUTE[k]]);b.copy(P[ROUTE[k+1]]);dir.subVectors(b,a);const len=dir.length();m.visible=gg>.001&&rfade>.01;m.position.copy(a).addScaledVector(dir,gg/2);m.scale.set(1,Math.max(.001,len*gg),1);m.quaternion.setFromUnitVectors(up,dir.normalize())});
  const full=rp>=ROUTE.length-1-.01;packet.visible=full&&rfade>.01;if(full){const s=(ta*.42)%1*(ROUTE.length-1),k=Math.min(ROUTE.length-2,Math.floor(s));packet.position.lerpVectors(P[ROUTE[k]],P[ROUTE[k+1]],s-k)}
  coin.visible=ring.visible=chainOn&&a3>.01;coinMat.opacity=a3;if(coin.visible){const k=Math.min(CH.length-2,Math.floor(cs));coin.position.lerpVectors(P[CH[k]],P[CH[k+1]],cs-k);
    const ph=(ta*.9)%1;ring.position.copy(P[CH[holder]]);ring.quaternion.copy(cam.quaternion);ring.scale.setScalar(.4+1.6*ph);ringMat.opacity=(1-ph)*a3*.9}
  const a1=win(p,.2,.13);firstMat.opacity=a1*.9;first1.visible=first2.visible=a1>.01;first1.rotation.set(ta*.12,ta*.2,0);first2.rotation.set(-ta*.08,-ta*.13,ta*.05);
  boxFg.opacity=boxAcc.opacity=a4;comp1.visible=comp2.visible=a4>.01;comp1.rotation.set(0,rot[C],0);comp2.rotation.set(ta*.1,ta*.16,0);comp2.scale.setScalar(.6+.4*a4);

  planes.forEach(m=>{m.material.opacity=1-sm(.3,.62,Math.abs(p*5-m.userData.k));m.visible=m.material.opacity>.01});
  const sr=SOLID.map(e=>e.getBoundingClientRect());
  LAB.forEach(l=>{const op=win(p,l.k/5,.085);if(op<.01){l.o=0;return}v.copy(cur[l.n]).project(cam);if(!l.w)l.w=l.el.offsetWidth;
    const X=(v.x*.5+.5)*W,Y=(-v.y*.5+.5)*H,dx=mob?10:l.dx,flip=X+dx+l.w>W-10,x0=flip?X-dx-l.w:X+dx;if(flip!==!!l.side){l.side=flip;l.el.classList.toggle('l',flip)}
    let o2=v.z<1?op:0;for(const r of sr)if(x0<r.right+12&&x0+l.w>r.left-12&&Y+12>r.top&&Y-12<r.bottom){o2=0;break}
    l.o=o2;l.x=x0;l.y=Y-9});
  const shown=LAB.filter(l=>l.o>.01).sort((a,b)=>a.y-b.y);for(let j=1;j<shown.length;j++)for(let h=0;h<j;h++){const A=shown[h],B=shown[j];if(B.x<A.x+A.w&&B.x+B.w>A.x&&B.y<A.y+18)B.y=A.y+18}
  LAB.forEach(l=>{if(l.x===undefined||!(l.o>.01)){l.el.style.opacity=0;return}l.el.style.opacity=l.o>.01?l.o:0;l.el.style.transform=`translate(${l.x.toFixed(1)}px,${l.y.toFixed(1)}px)`});
  if(!READ){hero.style.opacity=1-sm(.008,.045,p);
  const xi=Math.round(q*(NS-1)),near=SEQ[xi];if(xi!==subK){subK=xi;sub.textContent=SUB[near];cmd.textContent=CMD[near];cmd.style.display=CMD[near]?'block':'none';segs.forEach((s,k)=>s.classList.toggle('on',k===xi));
    const under=SUB[near]?sub:(xi===NS-1&&act.children.length?act:null);cmd.style.bottom=under?(parseFloat(getComputedStyle(under).bottom)+under.offsetHeight+16)+'px':''}
  const so=1-sm(.25,.5,Math.abs(q*(NS-1)-xi));sub.style.opacity=so;cmd.style.opacity=so;const ao=sm(1-.5/(NS-1),1-.07/(NS-1),q);act.style.opacity=ao;act.classList.toggle('on',ao>.6)}
  else if(PAGE.index)document.body.classList.toggle('past',scrollY>H*.45);
  renderer.render(scene,cam);requestAnimationFrame(frame)}
requestAnimationFrame(frame);

async function copyText(s){try{await navigator.clipboard.writeText(s);return true}catch(e){const a=document.createElement('textarea');a.value=s;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();let ok=false;try{ok=document.execCommand('copy')}catch(e2){}a.remove();return ok}}
const done=(b,label)=>{b.textContent='Copied';setTimeout(()=>{b.textContent=label},1600)};
document.querySelectorAll('.copyca').forEach(b=>b.addEventListener('click',async()=>{if(await copyText(b.dataset.ca))done(b,'Copy')}));
document.querySelectorAll('.code .copy').forEach(b=>b.addEventListener('click',async()=>{const pre=b.parentElement.querySelector('pre');if(pre&&await copyText(pre.textContent))done(b,'Copy')}));
