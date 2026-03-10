import express from 'express';
import fs from 'fs';
import chalk from 'chalk';
import multer from 'multer';
import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Boom } from '@hapi/boom';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

/* =========================
   Ensure required folders
========================= */
const requiredFolders = ['uploads','session','public'];
requiredFolders.forEach(folder=>{
    if(!fs.existsSync(folder)){
        fs.mkdirSync(folder,{recursive:true});
        console.log(`Created folder: ${folder}`);
    }
});

const upload = multer({ dest: 'uploads/' });

/* =========================
   Middleware
========================= */

app.use(cors({
    origin: "*",
    methods:["GET","POST"],
    allowedHeaders:["Content-Type"]
}));

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static('public'));

app.set("trust proxy",1);

/* =========================
   Variables
========================= */

const SESSION_FILE = './running_sessions.json';

const userSessions = {};
const stopFlags = {};
const activeSockets = {};
const messageQueues = {};
const reconnectAttempts = {};

/* =========================
   Utils
========================= */

const saveSessions=()=>{
    fs.writeFileSync(SESSION_FILE,JSON.stringify(userSessions,null,2));
}

const generateUniqueKey=()=>{
    return crypto.randomBytes(16).toString('hex');
}

/* =========================
   Messaging System
========================= */

const startMessaging=(sock,uniqueKey,target,hatersName,messages,speed)=>{

if(stopFlags[uniqueKey]?.interval){
clearInterval(stopFlags[uniqueKey].interval);
}

if(!messageQueues[uniqueKey]){
messageQueues[uniqueKey]={
messages:[...messages],
currentIndex:0,
isSending:false
};
}

const queue=messageQueues[uniqueKey];

const sendNext=async()=>{

if(stopFlags[uniqueKey]?.stopped) return;

if(queue.isSending) return;

queue.isSending=true;

const chatId=target.includes('@g.us')?target:`${target}@s.whatsapp.net`;

const msg=`${hatersName} ${queue.messages[queue.currentIndex]}`;

try{

await sock.sendMessage(chatId,{text:msg});

queue.currentIndex++;

if(queue.currentIndex>=queue.messages.length){
queue.currentIndex=0;
}

}catch(e){
console.log("Send error:",e.message);
}

queue.isSending=false;

}

const interval=parseInt(speed)*1000;

stopFlags[uniqueKey]={

stopped:false,
interval:setInterval(sendNext,interval)

};

sendNext();

}

/* =========================
   WhatsApp Connect
========================= */

const connectAndLogin=async(phoneNumber,uniqueKey,sendPairingCode=null)=>{

const sessionPath=`./session/${uniqueKey}`;

if(!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath,{recursive:true});

const {state,saveCreds}=await useMultiFileAuthState(sessionPath);

const {version}=await fetchLatestBaileysVersion();

const sock=makeWASocket({

version,
logger:pino({level:"silent"}),
browser:Browsers.windows('Firefox'),

auth:{
creds:state.creds,
keys:makeCacheableSignalKeyStore(state.keys,pino({level:"silent"}))
},

printQRInTerminal:false

});

activeSockets[uniqueKey]=sock;

/* Pairing */

if(!sock.authState.creds.registered && sendPairingCode){

setTimeout(async()=>{

const code=await sock.requestPairingCode(phoneNumber);

sendPairingCode(code,false);

},2000)

}

/* Events */

sock.ev.on("connection.update",update=>{

const {connection,lastDisconnect}=update;

if(connection==="open"){

userSessions[uniqueKey]={
phoneNumber,
uniqueKey,
connected:true
};

saveSessions();

if(sendPairingCode) sendPairingCode(null,true);

}

if(connection==="close"){

const reason=new Boom(lastDisconnect?.error)?.output?.statusCode;

if(reason!==DisconnectReason.loggedOut){

setTimeout(()=>connectAndLogin(phoneNumber,uniqueKey,sendPairingCode),5000);

}

}

});

sock.ev.on("creds.update",saveCreds);

}

/* =========================
   Routes
========================= */

/* Health check */

app.get("/health",(req,res)=>{
res.send("Server OK");
});

/* Home */

app.get("/",(req,res)=>{

const filePath=path.join(__dirname,'public','index.html');

if(fs.existsSync(filePath)){
res.sendFile(filePath);
}else{
res.send("Server running but index.html missing");
}

});

/* Login */

app.post("/login",async(req,res)=>{

let {phoneNumber}=req.body;

if(!phoneNumber){

return res.json({success:false,message:"Phone number required"});

}

phoneNumber=phoneNumber.replace(/[^0-9]/g,'');

const uniqueKey=generateUniqueKey();

stopFlags[uniqueKey]={stopped:false};

const sendPairingCode=(pairingCode,connected)=>{

if(connected){

res.json({
success:true,
connected:true,
uniqueKey
});

}else{

res.json({
success:true,
pairingCode,
uniqueKey
});

}

}

await connectAndLogin(phoneNumber,uniqueKey,sendPairingCode);

});

/* Groups */

app.post("/getGroupUID",async(req,res)=>{

const {uniqueKey}=req.body;

if(!activeSockets[uniqueKey]){

return res.json({success:false,message:"WhatsApp not connected"});

}

const sock=activeSockets[uniqueKey];

const groups=await sock.groupFetchAllParticipating();

const list=Object.values(groups).map(g=>({

groupName:g.subject,
groupId:g.id

}));

res.json({success:true,groupUIDs:list});

});

/* Start Messaging */

app.post('/startMessaging',upload.single('messageFile'),async(req,res)=>{

const {uniqueKey,target,hatersName,speed}=req.body;

if(!activeSockets[uniqueKey]){

return res.json({success:false,message:"WhatsApp not connected"});

}

const file=req.file.path;

const text=fs.readFileSync(file,'utf8');

fs.unlinkSync(file);

const messages=text.split("\n").filter(x=>x.trim());

startMessaging(activeSockets[uniqueKey],uniqueKey,target,hatersName,messages,speed);

res.json({
success:true,
messageCount:messages.length
});

});

/* Stop */

app.post("/stop",async(req,res)=>{

const {uniqueKey}=req.body;

if(stopFlags[uniqueKey]?.interval){

clearInterval(stopFlags[uniqueKey].interval);

}

if(activeSockets[uniqueKey]){

try{
await activeSockets[uniqueKey].logout();
}catch{}

delete activeSockets[uniqueKey];

}

delete stopFlags[uniqueKey];

delete messageQueues[uniqueKey];

delete userSessions[uniqueKey];

saveSessions();

res.json({success:true});

});

/* =========================
   Start Server
========================= */

app.listen(PORT,async()=>{

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━
SERVER RUNNING
PORT: ${PORT}
━━━━━━━━━━━━━━━━━━━━━━━━
`);

});
