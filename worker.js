const MAX_PLAYERS = 4;
const TICK_MS = 16;       // ~60 Hz authoritative simulation (smoother co-op)
const STATE_MS = 33;      // ~30 Hz snapshots; client prediction covers the rest
const WIDTH = 1200, HEIGHT = 700;
const TYPES = {
  broken:[.55,1,1,21,'Broken Heart','Common'], charger:[.10,.8,1.8,19,'Heart Charger','Uncommon'],
  duelist:[.06,1.15,1.2,22,'Heart Duelist','Uncommon'], archer:[.06,.9,.72,20,'Cupid Archer','Uncommon'],
  lancer:[.05,1.25,.95,24,'Rose Lancer','Uncommon'], tank:[.04,2.2,.55,27,'Grief Tank','Rare'],
  mage:[.03,1,.58,22,'Heart Mage','Rare'], splitter:[.03,1.5,.8,23,'Split Heart','Rare'],
  sentinel:[.02,1.65,.46,25,'Rose Sentinel','Rare'], guard:[.02,1.15,.62,24,'Cupid Guard','Uncommon'],
  mimic:[.02,1.4,.7,24,'Heart Mimic','Rare'], assassin:[.01,.72,1.65,18,'Love Assassin','Epic'],
  brute:[.01,2.7,.38,31,'Heart Brute','Epic'], berserker:[.01,1.35,1.3,24,'Love Berserker','Epic'],
  lovebreaker:[.01,2,.95,27,'Love Breaker','Epic'], witch:[.005,1.05,.5,22,'Heart Witch','Legendary']
};
const BOSS_DEFS = [
  {name:'Heartbreaker',icon:'💔',hp:7,spd:.70,atk:3.4,skill:'dash'},
  {name:'Rose Colossus',icon:'🌹',hp:11,spd:.42,atk:4.5,skill:'slam'},
  {name:'Cupid Tyrant',icon:'🏹',hp:8,spd:.58,atk:3.2,skill:'volley'},
  {name:'Broken Duchess',icon:'👑',hp:6.5,spd:.82,atk:3.0,skill:'summon'},
  {name:'Grief Knight',icon:'🛡️',hp:9,spd:.62,atk:4.0,skill:'shield'},
  {name:'Passion Beast',icon:'🔥',hp:8.5,spd:1.05,atk:3.7,skill:'charge'},
  {name:'Toxic Lover',icon:'☠️',hp:7.5,spd:.72,atk:3.1,skill:'poison'},
  {name:'Shadow Heart',icon:'🌑',hp:6,spd:1.15,atk:3.0,skill:'blink'},
  {name:'Love Reaper',icon:'🗡️',hp:10,spd:.76,atk:4.2,skill:'scythe'},
  {name:'Final Heart',icon:'❤️‍🔥',hp:14,spd:.55,atk:5.0,skill:'nova'}
];
const UPGRADE_CHOICES = [
  {id:'hp',icon:'❤️',name:'Vitality',desc:'Max HP +25'}, {id:'atk',icon:'⚔️',name:'Sharpness',desc:'Attack +4'},
  {id:'spd',icon:'💨',name:'Grace',desc:'Speed +0.35'}, {id:'crit',icon:'✨',name:'True Love',desc:'Crit +5%'},
  {id:'armor',icon:'🛡️',name:'Protection',desc:'Armor +3'}, {id:'heal',icon:'💗',name:'Second Heart',desc:'Heal 35% HP'}
];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const cleanRoom=s=>String(s||'LOVE').toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,24)||'LOVE';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket endpoint', {status:426});
      const room = cleanRoom(url.searchParams.get('room'));
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class Room {
  constructor(state) {
    this.state=state; this.sockets=new Map(); this.players=new Map();
    this.phase='lobby'; this.wave=1; this.enemies=[]; this.spawned=0; this.nextEnemy=1;
    this.lastTick=Date.now(); this.lastState=0; this.stateSeq=0; this.nextTickAlarm=null; this.countdownAt=0;
    this.offer=null; this.picks=new Map(); this.attackSeq=0; this.projectiles=[];
  }
  async fetch(request) {
    if(request.headers.get('Upgrade')!=='websocket') return new Response('Room online');
    if(this.sockets.size>=MAX_PLAYERS) return new Response('Room full',{status:429});
    const pair=new WebSocketPair(), client=pair[0], server=pair[1]; server.accept();
    const id=crypto.randomUUID();
    this.sockets.set(id,server);
    this.players.set(id,{id,name:'Player',x:WIDTH/2,y:HEIGHT/2,hp:100,maxHp:100,atk:14,spd:3.2,armor:0,crit:.08,ix:0,iy:0,angle:0,weapon:'sword',lastAttack:0,skillCd:0,skill:'',downed:false,reviveProgress:0,level:1,rebirths:0,mult:1,passives:[]});
    this.send(id,{type:'welcome',id,serverNow:Date.now(),phase:this.phase,wave:this.wave,state:this.snapshotFor(id),serverAuthoritative:true});
    this.broadcastPlayers(); this.ensureAlarm();
    const onMessage=e=>{try{this.message(id,JSON.parse(e.data))}catch{}};
    const cleanup=()=>{this.sockets.delete(id);this.players.delete(id);this.picks.delete(id);this.broadcastPlayers();if(this.players.size===0){this.resetRoom();}};
    server.addEventListener('message',onMessage); server.addEventListener('close',cleanup); server.addEventListener('error',cleanup);
    return new Response(null,{status:101,webSocket:client});
  }
  resetRoom(){this.phase='lobby';this.wave=1;this.enemies=[];this.projectiles=[];this.spawned=0;this.offer=null;this.picks.clear();this.countdownAt=0;}
  async ensureAlarm(){if(this.nextTickAlarm)return;this.nextTickAlarm=Date.now()+TICK_MS;try{await this.state.storage.setAlarm(this.nextTickAlarm)}catch{this.nextTickAlarm=null}}
  async alarm(){this.nextTickAlarm=null;const now=Date.now();this.tick(now);if(this.sockets.size)await this.ensureAlarm()}
  message(id,m){const p=this.players.get(id);if(!p)return;
    if(m.type==='join'){p.name=String(m.name||'Player').slice(0,20)||'Player';this.setStats(p,m.stats);if(m.progression){p.level=clamp(Number(m.progression.level)||p.level,1,9999);p.xp=clamp(Number(m.progression.xp)||0,0,1e12);p.rebirths=clamp(Number(m.progression.rebirths)||p.rebirths,0,9999);p.mult=clamp(Number(m.progression.mult)||p.mult,1,1000);p.progressRev=clamp(Number(m.progression.progressRev)||p.progressRev,0,1e9);}this.broadcastPlayers();this.broadcastState(true);return;}
    if(m.type==='progressSync' && m.progression){
      const pr=m.progression;
      const rev=clamp(Number(pr.progressRev)||0,0,1e9);
      if(rev>=p.progressRev){
        p.level=clamp(Number(pr.level)||p.level,1,9999);p.xp=clamp(Number(pr.xp)||0,0,1e12);p.rebirths=clamp(Number(pr.rebirths)||p.rebirths,0,9999);p.mult=clamp(Number(pr.mult)||p.mult,1,1000);
        p.progressRev=rev;
        this.send(id,{type:'progression',progression:this.progression(p)});this.broadcastState(true);
      }
      return;
    }
    if(m.type==='restartRequest' && this.phase==='gameover' && this.players.size>=1){
      if(m.stats)this.setStats(p,m.stats);
      this.phase='countdown';this.enemies=[];this.spawned=0;this.wave=1;this.picks.clear();this.offer=null;this.countdownAt=Date.now()+1200;
      for(const q of this.players.values()){q.x=WIDTH/2;q.y=HEIGHT/2;q.hp=q.maxHp;q.downed=false;q.reviveProgress=0;q.ix=0;q.iy=0;q.lastAttack=0}
      this.broadcast({type:'serverRestart',startAt:this.countdownAt,serverNow:Date.now()});this.broadcastState(true);return;
    }
    if(m.type==='startRequest' && this.phase==='lobby' && this.players.size>=1){
      this.setStats(p,m.stats);this.phase='countdown';this.enemies=[];this.spawned=0;this.wave=1;this.picks.clear();this.offer=null;this.countdownAt=Date.now()+2000;
      this.broadcast({type:'serverStart',startAt:this.countdownAt,serverNow:Date.now()});this.broadcastState(true);return;
    }
    if(m.type==='input' && (this.phase==='battle'||this.phase==='countdown')){
      p.angle=Number.isFinite(Number(m.angle))?Number(m.angle):p.angle;
      if(p.downed){p.ix=0;p.iy=0;return}
      p.ix=clamp(Number(m.x)||0,-1,1);p.iy=clamp(Number(m.y)||0,-1,1);return;
    }
    if(m.type==='attack' && this.phase==='battle' && !p.downed){this.serverAttack(p,m);return;}
    if(m.type==='skill' && this.phase==='battle' && !p.downed){this.serverSkill(p,m);return;}
    if(m.type==='weaponSwitch' && (this.phase==='battle'||this.phase==='countdown') && !p.downed){p.weapon=m.weapon==='bow'?'bow':'sword';this.broadcastState(true);return;}
    if(m.type==='upgradePick' && this.phase==='upgrade' && this.offer && m.offerId===this.offer.id && !this.picks.has(id)){
      const choice=String(m.choice||'');if(!this.offer.choices.some(c=>c.id===choice))return;
      this.picks.set(id,choice);this.applyUpgrade(p,choice);this.broadcast({type:'upgradeProgress',picked:this.picks.size,total:this.players.size});this.broadcast({type:'upgradePicked',playerId:id,choice});
      if(this.picks.size>=this.players.size){this.phase='countdown';this.wave++;this.spawned=0;this.enemies=[];this.offer=null;this.countdownAt=Date.now()+900;this.broadcast({type:'upgradeReady',wave:this.wave,startAt:this.countdownAt,serverNow:Date.now()});}
    }
  }
  setStats(p,s){
    if(!s)return;
    p.atk=clamp(Number(s.atk)||p.atk,1,10000);
    p.spd=clamp(Number(s.spd)||p.spd,.5,20);
    p.maxHp=clamp(Number(s.maxHp)||p.maxHp,20,100000);
    p.hp=clamp(Number(s.hp)||p.maxHp,1,p.maxHp);
    p.downed=false;p.reviveProgress=0;
    p.armor=clamp(Number(s.armor)||p.armor,0,1000);
    p.crit=clamp(Number(s.crit)||p.crit,0,1);
    p.skill=String(s.skill||p.skill||'').slice(0,32);p.skillCd=0;
    p.level=clamp(Number(s.level)||1,1,9999);
    p.xp=clamp(Number(s.xp)||0,0,1e12);
    p.progressRev=clamp(Number(s.progressRev)||0,0,1e9);
    p.rebirths=clamp(Number(s.rebirths)||0,0,9999);
    p.mult=clamp(Number(s.mult)||1,1,1000);
    p.passives=Array.isArray(s.passives)?s.passives.slice(0,32).map(String):[];
  }
  applyUpgrade(p,c){if(c==='hp'){p.maxHp+=25;p.hp+=25}else if(c==='atk')p.atk+=4;else if(c==='spd')p.spd+=.35;else if(c==='crit')p.crit=clamp(p.crit+.05,0,1);else if(c==='armor')p.armor+=3;else if(c==='heal')p.hp=Math.min(p.maxHp,p.hp+p.maxHp*.35)}
  spawn(){
    const side=Math.floor(Math.random()*4);let x,y;if(side===0){x=Math.random()*WIDTH;y=-40}else if(side===1){x=WIDTH+40;y=Math.random()*HEIGHT}else if(side===2){x=Math.random()*WIDTH;y=HEIGHT+40}else{x=-40;y=Math.random()*HEIGHT}
    let roll=Math.random(),rawType='broken';
    if(this.wave%5===0&&this.spawned===0)rawType='boss';
    else{let acc=0;for(const[k,v]of Object.entries(TYPES)){acc+=v[0];if(roll<acc){rawType=k;break}}}
    let isBoss=false,bossIndex=-1,bossDef=null,type=rawType;
    if(rawType==='boss'){
      isBoss=true;
      bossIndex=(Math.floor(this.wave/5)-1)%BOSS_DEFS.length;
      bossDef=BOSS_DEFS[bossIndex];
      type='boss_'+bossDef.name; // distinct per-boss type so each looks/behaves differently
    }
    let mult=1+this.wave*.15,hp=(34+this.wave*15)*mult,spd=.55+this.wave*.045+Math.random()*.35,atk=7+this.wave*1.7,r=21;
    if(isBoss){
      hp*=bossDef.hp;spd*=bossDef.spd;atk*=bossDef.atk;r=44;
    }else{const t=TYPES[type]||TYPES.broken;hp*=t[1];spd*=t[2];r=t[3];if(type==='charger')atk*=1.15;if(type==='tank')atk*=1.35;if(type==='duelist')atk*=1.65;if(type==='assassin')atk*=2;if(type==='brute')atk*=1.7;if(type==='lovebreaker')atk*=3;if(type==='berserker')atk*=2.35;if(type==='lancer')atk*=1.9;if(type==='witch')atk*=1.45}
    this.enemies.push({id:'e'+this.nextEnemy++,x,y,hp,maxHp:hp,r,speed:spd,atk,hit:0,attack:.7+Math.random(),type,boss:isBoss,bossIndex,bossDef,shieldT:0,specialCd:isBoss?2.2+Math.random()*1.5:0,
name:isBoss?bossDef.name:(TYPES[type]?.[4]||'Broken Heart'),rarity:isBoss?'Legendary':(TYPES[type]?.[5]||'Common')});this.spawned++;
  }
  xpNeed(level){return Math.floor(100*Math.pow(1.12,Math.max(0,level-1)))}
  awardXp(p,amount){
    if(!p||!amount)return;
    p.xp=Math.max(0,p.xp+Math.max(0,Number(amount)||0));
    let leveled=false;
    while(p.xp>=this.xpNeed(p.level)){
      p.xp-=this.xpNeed(p.level); p.level++; leveled=true;
      const scale=p.mult||1;
      p.maxHp+=Math.round(12*scale); p.atk+=Math.round(2.5*scale*10)/10; p.spd+=.05*scale; p.armor+=.35*scale;
      p.hp=p.maxHp;
    }
    p.progressRev++;
    return leveled;
  }
  progression(p){return {level:p.level||1,xp:p.xp||0,rebirths:p.rebirths||0,mult:p.mult||1,progressRev:p.progressRev||0}}
  killEnemy(e,owner){
    if(!e||!this.enemies.some(x=>x.id===e.id))return;
    const reward=e.boss?80+this.wave*8:3+Math.floor(this.wave*.9);
    const xp=(e.boss?180:25)+this.wave*6;
    this.enemies=this.enemies.filter(x=>x.id!==e.id);
    const p=owner?this.players.get(owner):null;
    if(p){this.awardXp(p,xp);this.send(owner,{type:'reward',reward,xp,progression:this.progression(p)});}
  }
  serverSkill(p,m){
    const now=Date.now();
    if(p.skillCd>0)return;
    const requestedSkill=String(m.skill||p.skill||'');
    const SKILL_ALIASES={
      nova:'nova', dash:'dash', barrage:'barrage', moon:'moon', storm:'storm',
      bloom:'moon', break:'barrage', eclipse:'storm', divine:'nova', cataclysm:'moon'
    };
    const skill=SKILL_ALIASES[requestedSkill]||'';
    const angle=Number.isFinite(Number(m.angle))?Number(m.angle):p.angle;
    p.angle=angle;
    const stats=m.stats?.atk||p.atk;
    const defs={nova:{cd:8},dash:{cd:5},barrage:{cd:10},moon:{cd:7},storm:{cd:12}};
    if(!skill)return;
    p.skillCd=defs[skill].cd;
    const hitIds=[];
    const damage=(e,mult)=>{if(!e||e.hp<=0)return;let d=stats*mult;if(Math.random()<p.crit)d*=2;e.hp=Math.max(0,e.hp-d);e.hit=.12;hitIds.push({id:e.id,damage:d});};
    if(skill==='nova'){
      for(const e of this.enemies)if(dist(e,p)<190)damage(e,3);
      this.broadcast({type:'skillFx',skill:requestedSkill,baseSkill:skill,from:p.id,x:p.x,y:p.y,angle,hitIds,serverNow:now});
    }else if(skill==='barrage'){
      for(let j=-2;j<=2;j++){
        const a=angle+j*.18;
        for(const e of this.enemies){
          const dx=e.x-p.x,dy=e.y-p.y,d=Math.hypot(dx,dy);
          let da=Math.atan2(dy,dx)-a;da=Math.atan2(Math.sin(da),Math.cos(da));
          if(d<165&&Math.abs(da)<.65)damage(e,2.2);
        }
      }
      this.broadcast({type:'skillFx',skill:requestedSkill,baseSkill:skill,from:p.id,x:p.x,y:p.y,angle,hitIds,serverNow:now});
    }else if(skill==='moon'){
      const proj={id:'s'+(++this.attackSeq),owner:p.id,x:p.x,y:p.y,vx:Math.cos(angle)*7,vy:Math.sin(angle)*7,angle,life:2.2,damage:stats*5,skill:'moon',radius:18};
      this.projectiles.push(proj);
      this.broadcast({type:'skillFx',skill:requestedSkill,baseSkill:skill,from:p.id,x:p.x,y:p.y,angle,projectile:proj,serverNow:now});
    }else if(skill==='storm'){
      for(const e of this.enemies)if(dist(e,p)<260)damage(e,2.5);
      this.broadcast({type:'skillFx',skill:requestedSkill,baseSkill:skill,from:p.id,x:p.x,y:p.y,angle,hitIds,serverNow:now});
    }else if(skill==='dash'){
      p.x=clamp(p.x+Math.cos(angle)*180,30,WIDTH-30);p.y=clamp(p.y+Math.sin(angle)*180,62,HEIGHT-30);
      for(const e of this.enemies)if(dist(e,p)<75)damage(e,2);
      this.broadcast({type:'skillFx',skill:requestedSkill,baseSkill:skill,from:p.id,x:p.x,y:p.y,angle,hitIds,serverNow:now});
    }
    for(const h of hitIds){
      const e=this.enemies.find(q=>q.id===h.id);
      if(e&&e.hp<=0)this.killEnemy(e,p.id);
    }
    this.broadcastState(true);
  }
  serverAttack(p,m){
    const now=Date.now();if(now-p.lastAttack<500)return;p.lastAttack=now;
    const weapon=m.weapon==='bow'?'bow':'sword';p.weapon=weapon;
    const angle=Number.isFinite(Number(m.angle))?Number(m.angle):p.angle;p.angle=angle;
    if(weapon==='bow'){
      const projectile={
        id:'a'+(++this.attackSeq),owner:p.id,x:p.x+Math.cos(angle)*22,y:p.y+Math.sin(angle)*22,
        vx:Math.cos(angle)*8.5,vy:Math.sin(angle)*8.5,angle,life:1.8,damage:clamp(Number(m.stats?.atk)||p.atk,1,10000),
        crit:Math.random()<p.crit,hit:false,radius:8
      };
      this.projectiles.push(projectile);
      this.broadcast({type:'fx',kind:'projectile',projectile:{id:projectile.id,owner:p.id,x:projectile.x,y:projectile.y,vx:projectile.vx,vy:projectile.vy,angle,weapon:'bow'},serverNow:now});
      return;
    }
    let best=null,bestAlong=Infinity;
    const maxRange=125,hitWidth=52,ca=Math.cos(angle),sa=Math.sin(angle);
    for(const e of this.enemies){
      const rx=e.x-p.x,ry=e.y-p.y,along=rx*ca+ry*sa;
      if(along<0||along>maxRange)continue;
      const side=Math.abs(-rx*sa+ry*ca),radius=(e.r||20)+hitWidth;
      if(side>radius)continue;
      if(along<bestAlong){best=e;bestAlong=along}
    }
    let hitX=p.x+ca*maxRange,hitY=p.y+sa*maxRange;
    if(best){
      hitX=best.x;hitY=best.y;
      let dmg=clamp(Number(m.stats?.atk)||p.atk,1,10000);if(best.shieldT>0)dmg*=.35;if(Math.random()<p.crit)dmg*=2;
      best.hp-=dmg;best.hit=.12;
      if(best.hp<=0){this.killEnemy(best,p.id);}
    }
    this.broadcast({type:'fx',kind:'attack',attackId:++this.attackSeq,from:p.id,x:p.x,y:p.y,angle,weapon:'sword',hit:!!best,hitX,hitY,serverNow:now});
  }
  tick(now){
    const raw=Math.max(0,Math.min(250,now-this.lastTick));this.lastTick=now;
    if(this.phase==='countdown' && now>=this.countdownAt){this.phase='battle';this.broadcast({type:'phase',phase:'battle',wave:this.wave,serverNow:now});}
    if(this.phase!=='battle')return;
    const dt=raw/1000;
    for(const p of this.players.values()){p.skillCd=Math.max(0,(p.skillCd||0)-raw/1000);
      if(p.downed){p.ix=0;p.iy=0;continue}
      const l=Math.hypot(p.ix,p.iy)||1;p.x=clamp(p.x+p.ix/l*p.spd*60*dt,30,WIDTH-30);p.y=clamp(p.y+p.iy/l*p.spd*60*dt,62,HEIGHT-30);
    }
    // Authoritative co-op arrows: move on the server and damage only on actual collision.
    for(const a of this.projectiles){
      // Continuous/swept collision: test the whole arrow segment for this server tick.
      // This prevents tunnelling and makes damage happen exactly when the moving arrow
      // reaches the first enemy, rather than before it visually arrives.
      const prevX=a.x,prevY=a.y;
      const stepX=a.vx*60*dt,stepY=a.vy*60*dt;
      const nextX=prevX+stepX,nextY=prevY+stepY;
      a.x=nextX;a.y=nextY;a.life-=dt;
      let first=null,bestT=Infinity;
      const segLenSq=stepX*stepX+stepY*stepY||1;
      for(const e of this.enemies){
        const ex=e.x-prevX,ey=e.y-prevY;
        let t=(ex*stepX+ey*stepY)/segLenSq;
        t=Math.max(0,Math.min(1,t));
        const cx=prevX+stepX*t,cy=prevY+stepY*t;
        const hitRadius=(e.r||20)+(a.radius||8);
        const dx=e.x-cx,dy=e.y-cy;
        if(dx*dx+dy*dy<=hitRadius*hitRadius && t<bestT){
          first=e;bestT=t;
        }
      }
      if(first && a.owner!=='enemy'){
        a.x=prevX+stepX*bestT;a.y=prevY+stepY*bestT;
        let dmg=a.damage;if(a.crit)dmg*=2;if(first.shieldT>0)dmg*=.35;
        first.hp-=dmg;first.hit=.12;a.hit=true;a.hitX=a.x;a.hitY=a.y;a.life=0;
        this.broadcast({type:'projectileHit',projectileId:a.id,x:a.x,y:a.y,enemyId:first.id,damage:dmg,serverNow:now});
        if(first.hp<=0)this.killEnemy(first,a.owner);
      }
    }
    for(const a of this.projectiles){
      if(a.owner!=='enemy'||a.life<=0)continue;
      for(const p of this.players.values()){
        if(p.downed)continue;
        const rr=22+(a.radius||8),dx=p.x-a.x,dy=p.y-a.y;
        if(dx*dx+dy*dy<=rr*rr){
          const dmg=Math.max(1,a.damage-p.armor*.35);
          p.hp=Math.max(0,p.hp-dmg);a.life=0;
          this.broadcast({type:'enemyProjectileHit',projectileId:a.id,playerId:p.id,x:a.x,y:a.y,damage:dmg,serverNow:now});
          if(p.hp<=0){p.hp=0;p.downed=true;p.ix=p.iy=0;this.broadcast({type:'downed',playerId:p.id,x:p.x,y:p.y})}
          break;
        }
      }
    }
    this.projectiles=this.projectiles.filter(a=>a.life>0&&a.x>-100&&a.x<WIDTH+100&&a.y>-100&&a.y<HEIGHT+100);

    // A downed player stays down until another living player stands nearby for 2 seconds.
    for(const p of this.players.values()){
      if(!p.downed){p.reviveProgress=0;continue}
      let rescuer=null;
      for(const q of this.players.values()){
        if(q.id!==p.id && !q.downed && dist(p,q)<=68){rescuer=q;break}
      }
      if(rescuer){
        p.reviveProgress=Math.min(2,p.reviveProgress+dt);
        if(p.reviveProgress>=2){
          p.downed=false;p.hp=Math.max(1,Math.round(p.maxHp*.35));p.reviveProgress=0;p.inv=1.2;
          this.broadcast({type:'revive',playerId:p.id,reviverId:rescuer.id,x:p.x,y:p.y});
        }
      }else p.reviveProgress=Math.max(0,p.reviveProgress-dt*2);
    }
    if(this.phase==='battle' && this.players.size>0){
      let alive=0;for(const q of this.players.values())if(!q.downed)alive++;
      if(alive===0){
        this.phase='gameover';
        this.enemies=[];this.spawned=0;this.picks.clear();this.offer=null;
        this.broadcast({type:'gameOver',reason:'allDowned',serverNow:Date.now()});
        this.broadcastState(true);
        return;
      }
    }
    for(const e of this.enemies){
      if(e.boss){
        e.specialCd=Math.max(0,(e.specialCd||0)-dt);
        e.shieldT=Math.max(0,(e.shieldT||0)-dt);
        if(e.specialCd<=0){
          const living=[...this.players.values()].filter(p=>!p.downed);
          if(living.length){
            let target=living[0],bd=dist(e,target);
            for(const q of living){const qd=dist(e,q);if(qd<bd){bd=qd;target=q}}
            const a=Math.atan2(target.y-e.y,target.x-e.x);
            const sk=e.bossDef?.skill;
            e.specialCd=2.2+Math.random()*1.5;
            if(sk==='dash'){e.dashT=.55;e.dashA=a}
            else if(sk==='charge'){e.chargeT=.65;e.chargeA=a}
            else if(sk==='blink'){
              e.x=clamp(target.x-Math.cos(a)*150,60,WIDTH-60);e.y=clamp(target.y-Math.sin(a)*150,90,HEIGHT-60);
              this.broadcast({type:'bossFx',kind:'blink',enemyId:e.id,x:e.x,y:e.y});
            } else if(sk==='slam'){
              if(bd<210){target.hp=Math.max(0,target.hp-Math.max(1,e.atk*1.6));if(target.hp<=0){target.hp=0;target.downed=true;target.ix=target.iy=0;this.broadcast({type:'downed',playerId:target.id,x:target.x,y:target.y})}}
              this.broadcast({type:'bossFx',kind:'slam',enemyId:e.id,x:e.x,y:e.y});
            } else if(sk==='shield'){e.shieldT=1.2;this.broadcast({type:'bossFx',kind:'shield',enemyId:e.id,x:e.x,y:e.y})}
            else if(sk==='summon'){for(let i=0;i<2;i++)this.spawn();this.broadcast({type:'bossFx',kind:'summon',enemyId:e.id,x:e.x,y:e.y})}
            else if(sk==='volley'||sk==='scythe'||sk==='nova'){
              const count=sk==='volley'?7:5, speed=sk==='scythe'?5.8:4.7;
              for(let j=0;j<count;j++){const aa=a+(j-(count-1)/2)*.18;this.projectiles.push({id:'b'+(++this.attackSeq),owner:'enemy',source:e.id,x:e.x,y:e.y,vx:Math.cos(aa)*speed,vy:Math.sin(aa)*speed,angle:aa,life:2.5,damage:e.atk*.45,radius:8,crit:false});}
              this.broadcast({type:'bossFx',kind:'volley',enemyId:e.id,x:e.x,y:e.y});
            } else if(sk==='poison'){
              this.projectiles.push({id:'b'+(++this.attackSeq),owner:'enemy',source:e.id,x:e.x,y:e.y,vx:Math.cos(a)*3.8,vy:Math.sin(a)*3.8,angle:a,life:2.8,damage:e.atk*.65,radius:10,crit:false,poison:true});
            }
          }
        }
        if(e.dashT>0){e.dashT-=dt;e.x+=Math.cos(e.dashA)*7*60*dt;e.y+=Math.sin(e.dashA)*7*60*dt}
        else if(e.chargeT>0){e.chargeT-=dt;e.x+=Math.cos(e.chargeA)*8*60*dt;e.y+=Math.sin(e.chargeA)*8*60*dt}
      }
      let target=null,bd=Infinity;for(const p of this.players.values()){if(p.downed)continue;const d=dist(e,p);if(d<bd){bd=d;target=p}}
      if(!target)continue;
      const dx=target.x-e.x,dy=target.y-e.y,d=Math.hypot(dx,dy)||1,contact=e.boss?72:46;
      // Boss lunge (dash/charge): damage ONLY on real body contact, never from range.
      if(e.dashT>0||e.chargeT>0){
        if(d<=contact){const dmg=Math.max(1,e.atk*(e.boss?1.4:1.2)-target.armor*.7);target.hp=Math.max(0,target.hp-dmg);e.attack=.5;if(target.hp<=0){target.hp=0;target.downed=true;target.ix=target.iy=0;this.broadcast({type:'downed',playerId:target.id,x:target.x,y:target.y})}}
      } else if(e.type==='archer'){
        if(d>280){e.x+=dx/d*e.speed*60*dt;e.y+=dy/d*e.speed*60*dt}else if(d<190){e.x-=dx/d*e.speed*60*dt;e.y-=dy/d*e.speed*60*dt}
        e.attack-=dt;if(e.attack<=0){e.attack=1.25;const a=Math.atan2(dy,dx);this.projectiles.push({id:'b'+(++this.attackSeq),owner:'enemy',source:e.id,x:e.x,y:e.y,vx:Math.cos(a)*4.8,vy:Math.sin(a)*4.8,angle:a,life:2.4,damage:e.atk*.85,radius:8,crit:false});this.broadcast({type:'bossFx',kind:'volley',enemyId:e.id,x:e.x,y:e.y})}
      } else if(e.type==='mage'){
        if(d>330){e.x+=dx/d*e.speed*60*dt;e.y+=dy/d*e.speed*60*dt}else if(d<250){e.x-=dx/d*e.speed*60*dt;e.y-=dy/d*e.speed*60*dt}
        e.attack-=dt;if(e.attack<=0){e.attack=2.0;const a=Math.atan2(dy,dx);for(let j=-1;j<=1;j++){const aa=a+j*.22;this.projectiles.push({id:'b'+(++this.attackSeq),owner:'enemy',source:e.id,x:e.x,y:e.y,vx:Math.cos(aa)*3.8,vy:Math.sin(aa)*3.8,angle:aa,life:2.4,damage:e.atk*.9,radius:8,crit:false})}}
      } else if(e.type==='witch'){
        if(d>390){e.x+=dx/d*e.speed*60*dt;e.y+=dy/d*e.speed*60*dt}else if(d<300){e.x-=dx/d*e.speed*60*dt;e.y-=dy/d*e.speed*60*dt}
        e.specialCd=Math.max(0,(e.specialCd||0)-dt);e.attack-=dt;
        if(e.specialCd<=0){e.specialCd=9.5;const se={id:'e'+(++this.nextEnemy),x:e.x+38,y:e.y+18,hp:(28+this.wave*8),maxHp:(28+this.wave*8),r:16,speed:.28,atk:4+this.wave*.6,hit:0,attack:.9,vx:0,vy:0,type:'witchling',boss:false,bossIndex:-1,bossDef:null,name:'Witchling',rarity:'Common',shieldT:0,specialCd:99};this.enemies.push(se);this.broadcast({type:'bossFx',kind:'summon',enemyId:e.id,x:e.x,y:e.y})}
        if(e.attack<=0){e.attack=2.0;const a=Math.atan2(dy,dx);this.projectiles.push({id:'b'+(++this.attackSeq),owner:'enemy',source:e.id,x:e.x,y:e.y,vx:Math.cos(a)*4.4,vy:Math.sin(a)*4.4,life:3.0,damage:e.atk*1.15,radius:8,crit:false,kind:'fire'});this.broadcast({type:'bossFx',kind:'volley',enemyId:e.id,x:e.x,y:e.y})}
      } else if(e.type==='witchling'){
        if(d>90){e.x+=dx/d*e.speed*60*dt;e.y+=dy/d*e.speed*60*dt}else{e.attack-=dt;if(e.attack<=0){e.attack=1.8;const dmg=Math.max(1,e.atk-target.armor*.7);target.hp=Math.max(0,target.hp-dmg);if(target.hp<=0){target.hp=0;target.downed=true;target.ix=target.iy=0;this.broadcast({type:'downed',playerId:target.id,x:target.x,y:target.y})}}}
      } else if(d>contact){e.x+=dx/d*e.speed*60*dt;e.y+=dy/d*e.speed*60*dt}
      else{e.attack-=dt;if(e.attack<=0){e.attack=e.boss?1.5:.9;const dmg=Math.max(1,e.atk-target.armor*.7);target.hp=Math.max(0,target.hp-dmg);if(target.hp<=0){target.hp=0;target.downed=true;target.ix=target.iy=0;this.broadcast({type:'downed',playerId:target.id,x:target.x,y:target.y})}}}
      e.x=clamp(e.x,-60,WIDTH+60);e.y=clamp(e.y,-60,HEIGHT+60);e.hit=Math.max(0,e.hit-dt);
    }
    const targetCount=this.wave%5===0?1:this.wave*3+4;
    if(this.spawned<targetCount&&this.enemies.length<Math.min(6+this.wave,15))this.spawn();
    if(this.spawned>=targetCount&&this.enemies.length===0){this.phase='upgrade';this.offer={id:String(Date.now())+Math.random(),choices:[...UPGRADE_CHOICES].sort(()=>Math.random()-.5).slice(0,3)};this.picks.clear();this.broadcast({type:'upgradeOffer',offerId:this.offer.id,choices:this.offer.choices,serverNow:now});return;}
    if(now-this.lastState>=STATE_MS)this.broadcastState(false)
  }
  snapshotFor(id){const p=this.players.get(id);return this.makeState(p)}
  makeState(p){return {phase:this.phase,wave:this.wave,stateSeq:this.stateSeq,serverNow:Date.now(),player:p?{x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp,angle:p.angle,atk:p.atk,spd:p.spd,armor:p.armor,crit:p.crit,weapon:p.weapon||'sword',skill:p.skill||'',skillCd:p.skillCd||0,downed:!!p.downed,reviveProgress:p.reviveProgress||0,progression:this.progression(p)}:null,players:[...this.players.values()].map(q=>({id:q.id,name:q.name,x:q.x,y:q.y,hp:q.hp,maxHp:q.maxHp,angle:q.angle,weapon:q.weapon||'sword',skill:q.skill||'',skillCd:q.skillCd||0,downed:!!q.downed,reviveProgress:q.reviveProgress||0,level:q.level||1,xp:q.xp||0,rebirths:q.rebirths||0,mult:q.mult||1,progressRev:q.progressRev||0})),enemies:this.enemies,projectiles:this.projectiles.map(a=>({id:a.id,owner:a.owner,x:a.x,y:a.y,vx:a.vx,vy:a.vy,angle:a.angle,life:a.life}))}}
  broadcastState(force=false){
    const now=Date.now();
    if(!force && now-this.lastState<STATE_MS)return;
    this.lastState=now;
    this.stateSeq++;
    for(const id of this.sockets.keys())this.send(id,{type:'state',...this.makeState(this.players.get(id))});
  }
  broadcastPlayers(){this.broadcast({type:'players',players:[...this.players.values()].map(p=>({id:p.id,name:p.name,x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp,angle:p.angle,weapon:p.weapon||'sword',skill:p.skill||'',skillCd:p.skillCd||0,downed:!!p.downed,reviveProgress:p.reviveProgress||0}))})}
  send(id,msg){const ws=this.sockets.get(id);if(ws)try{ws.send(JSON.stringify(msg))}catch{}}
  broadcast(msg){const d=JSON.stringify(msg);for(const[id,ws]of this.sockets){try{ws.send(d)}catch{this.sockets.delete(id);this.players.delete(id)}}}
}
