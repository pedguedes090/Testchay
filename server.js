import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROLES = {
  4: ['moveCamera', 'pace', 'jump', 'actionThrow'],
  5: ['move', 'pace', 'jump', 'camera', 'actionThrow'],
  6: ['move', 'pace', 'jump', 'action', 'camera', 'throw']
};
const ACTIONS = {
  move: ['left','right'], pace: ['accelerate','brake'], jump: ['jump'], action: ['slide'],
  camera: ['cameraLeft','cameraRight'], throw: ['throw'], actionThrow: ['slide','throw'],
  moveCamera: ['left','right','cameraLeft','cameraRight']
};
const rooms = new Map();

export function validName(value) {
  const name = String(value ?? '').trim();
  return name.length >= 2 && name.length <= 16 && /^[\p{L}\p{N}_ -]+$/u.test(name);
}
export function rolesForCount(count) {
  if (!ROLES[count]) throw new RangeError('Cần 4–6 người');
  return [...ROLES[count]];
}
export function canPerform(role, action) { return Boolean(ACTIONS[role]?.includes(action)); }
export function newRoomCode(random = Math.random) {
  let code;
  do code = Array.from({length:5}, () => ALPHABET[Math.floor(random()*ALPHABET.length)]).join(''); while (rooms.has(code));
  return code;
}
function shuffle(values) {
  const result = [...values];
  for (let i=result.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [result[i],result[j]]=[result[j],result[i]]; }
  return result;
}
function assign(room) {
  const players = room.players.filter(p => p.connected || p.bot);
  const roles = shuffle(rolesForCount(players.length));
  room.assignment = Object.fromEntries(players.map((p,i)=>[p.id,roles[i]]));
  room.inputs = Object.fromEntries(players.map(p=>[p.id,{}]));
}
function publicRoom(room, viewerId) {
  return {
    code: room.code, phase: room.phase, viewerId, hostId: room.hostId, announcement: room.announcement,
    players: room.players.map(p=>({id:p.id,name:p.name,bot:p.bot,connected:p.connected,role:room.assignment[p.id]||null})),
    countdownMs: Math.max(0,(room.countdownEndsAt||0)-Date.now()),
    game: room.game ? {...room.game,remainingMs:Math.max(0,room.game.endsAt-Date.now()),nextShuffleMs:Math.max(0,room.game.nextShuffleAt-Date.now())} : null
  };
}
function frame(text) {
  const data=Buffer.from(text); if(data.length>=126) throw new Error('payload too large');
  return Buffer.concat([Buffer.from([0x81,data.length]),data]);
}
function parseFrame(buffer) {
  if(buffer.length<6) return null;
  const len=buffer[1]&0x7f, masked=Boolean(buffer[1]&0x80), offset=masked?6:2;
  if(buffer.length<offset+len) return null;
  const payload=Buffer.from(buffer.subarray(offset,offset+len));
  if(masked){const mask=buffer.subarray(2,6);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];}
  return payload.toString();
}
function send(client, value){if(!client.socket.destroyed)client.socket.write(frame(JSON.stringify(value)));}
function createPlayer(name,bot=false){return{id:crypto.randomUUID(),token:crypto.randomBytes(18).toString('base64url'),name,bot,connected:true,sequence:-1};}
function emptyGame(){return{x:4,y:0,vy:0,speed:0,truckX:42,collisions:0,bagIntegrity:100,delivered:false,score:null,reason:null,endsAt:Date.now()+120000,nextShuffleAt:Date.now()+20000};}
function tickGame(room,dt){
  const g=room.game, merged={};
  for(const p of room.players){const role=room.assignment[p.id], input=room.inputs[p.id]||{};for(const [a,on] of Object.entries(input))if(on&&canPerform(role,a))merged[a]=true;}
  for(const p of room.players.filter(p=>p.bot)){
    const role=room.assignment[p.id]; if(['move','moveCamera'].includes(role))merged.right=true; if(role==='pace')merged.accelerate=true;
    if(role==='jump'&&[18,32,47,78].some(h=>h-g.x>0&&h-g.x<1.7))merged.jump=true;
    if(['throw','actionThrow'].includes(role)&&Math.abs(g.truckX-g.x)<7&&g.x>20)merged.throw=true;
  }
  const dir=Number(Boolean(merged.right))-Number(Boolean(merged.left));
  const target=merged.brake?1.2:merged.accelerate?8.2:4.8; g.speed+=(target-g.speed)*Math.min(1,dt*5); g.x=Math.max(0,Math.min(106,g.x+dir*g.speed*dt));
  if(merged.jump&&g.y===0)g.vy=8.5; g.vy-=21*dt; g.y=Math.max(0,g.y+g.vy*dt); if(g.y===0&&g.vy<0)g.vy=0;
  g.truckX+=2.3*dt;
  if(merged.throw&&Math.abs(g.truckX-g.x)<=7.5&&g.x>20){g.delivered=true;g.reason='delivered';g.score=Math.max(0,Math.round((g.endsAt-Date.now())/20+g.bagIntegrity*20));}
  if(Date.now()>=g.endsAt&&!g.reason){g.reason='timeout';g.score=0;} if(g.truckX>=106&&!g.reason){g.reason='truck_left';g.score=0;}
  if(g.reason){room.phase='FINISHED';room.announcement=g.delivered?'Giao rác thành công!':'Xe rác chạy mất!';}
}

const clients=new Set();
const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,rooms:rooms.size}));}
  const file=path.join(ROOT,req.url==='/'?'index.html':path.basename(req.url)); if(!file.startsWith(ROOT)||!fs.existsSync(file)){res.writeHead(404);return res.end('Not found');}
  res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':'text/plain'});fs.createReadStream(file).pipe(res);
});
server.on('upgrade',(req,socket)=>{
  const key=req.headers['sec-websocket-key']; if(req.url!=='/ws'||!key)return socket.destroy();
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client={socket,room:null,id:null};clients.add(client);
  socket.on('data',chunk=>{try{const raw=parseFrame(chunk);if(!raw)return;const m=JSON.parse(raw);let room,player;
    if(m.type==='create'){if(!validName(m.name))throw Error('Tên không hợp lệ');player=createPlayer(m.name.trim());room={code:newRoomCode(),phase:'LOBBY',hostId:player.id,players:[player],assignment:{},inputs:{},announcement:'Phòng đã tạo'};rooms.set(room.code,room);}
    else if(m.type==='join'){room=rooms.get(String(m.code||'').toUpperCase());if(!room||room.phase!=='LOBBY')throw Error('Không thể vào phòng');if(room.players.length>=6)throw Error('Phòng đầy');if(!validName(m.name))throw Error('Tên không hợp lệ');player=createPlayer(m.name.trim());room.players.push(player);}
    else {room=rooms.get(client.room);player=room?.players.find(p=>p.id===client.id);if(!room||!player)throw Error('Chưa vào phòng');
      if(m.type==='add_bot'){if(room.hostId!==player.id||room.players.length>=6)throw Error('Không thể thêm bot');room.players.push(createPlayer(`Bot ${room.players.filter(p=>p.bot).length+1}`,true));}
      if(m.type==='start'){if(room.hostId!==player.id||room.players.length<4)throw Error('Cần đủ 4 người');assign(room);room.phase='COUNTDOWN';room.countdownEndsAt=Date.now()+5000;room.announcement='Chuẩn bị!';}
      if(m.type==='input'&&room.phase==='PLAYING'&&m.sequence>player.sequence&&canPerform(room.assignment[player.id],m.action)){player.sequence=m.sequence;room.inputs[player.id][m.action]=Boolean(m.pressed);}
      if(m.type==='rematch'&&room.phase==='FINISHED'){room.phase='LOBBY';room.game=null;room.assignment={};room.announcement='Sẵn sàng chơi lại';}
    }
    if(player&&room&&client.id===null){client.room=room.code;client.id=player.id;send(client,{type:'welcome',roomCode:room.code,sessionId:player.id,reconnectToken:player.token});}
  }catch(e){send(client,{type:'error',message:e.message});}});
  socket.on('close',()=>{clients.delete(client);const room=rooms.get(client.room),p=room?.players.find(p=>p.id===client.id);if(p)p.connected=false;});
});
let last=Date.now();setInterval(()=>{const now=Date.now(),dt=Math.min(.1,(now-last)/1000);last=now;for(const room of rooms.values()){
  if(room.phase==='COUNTDOWN'&&now>=room.countdownEndsAt){room.phase='PLAYING';room.game=emptyGame();room.announcement='Chạy!';}
  if(room.phase==='PLAYING'&&room.game){if(now>=room.game.nextShuffleAt){assign(room);room.game.nextShuffleAt=now+20000;room.announcement='ĐỔI QUYỀN!';}tickGame(room,dt);}
}},1000/30).unref();
setInterval(()=>{for(const c of clients){const r=rooms.get(c.room);if(r)send(c,{type:'state',state:publicRoom(r,c.id)});}},100).unref();
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)server.listen(PORT,'0.0.0.0',()=>console.log(`Game: http://localhost:${PORT}`));
export {server,rooms};
