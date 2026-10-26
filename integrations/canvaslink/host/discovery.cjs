const {spawn}=require('node:child_process');
const {lanAddresses}=require('./network.cjs');
// macOS mDNSResponder owns multicast publication. UDP-only JS Bonjour can
// report "up" while its records remain invisible to native DNS-SD browsers.
function publish({name,port,ipv4=lanAddresses()[0]||'',embedded=false}){
 if(process.platform==='darwin'){
   const child=spawn('/usr/bin/dns-sd',['-R',name,'_canvaslink._tcp','local.',String(port),'v=2','ipv4='+ipv4,'host='+(embedded?'canvastty':'standalone')],{stdio:'ignore'});
   child.on('error',()=>{});
   return {destroy(){child.kill('SIGTERM');}};
 }
 const {Bonjour}=require('bonjour-service'),publishers=new Map();let destroyed=false;
 const stop=bonjour=>bonjour.unpublishAll(()=>bonjour.destroy());
 const refresh=()=>{
  const addresses=lanAddresses();
  for(const [address,bonjour] of publishers)if(!addresses.includes(address)){publishers.delete(address);stop(bonjour);}
  for(const address of addresses){
   if(publishers.has(address))continue;
   // Bind multicast to the LAN adapter instead of the VPN's default route.
   const onError=error=>console.warn('CanvasLink discovery unavailable:',error.code||error.message);
   const bonjour=new Bonjour({interface:address,bind:'0.0.0.0'},onError);
   bonjour.server.mdns.on('error',onError);
   const service=bonjour.publish({name:`${name} (${address})`,host:`canvaslink-${address.replaceAll('.','-')}.local`,type:'canvaslink',port,disableIPv6:true,txt:{v:'2',ipv4:address,host:embedded?'canvastty':'standalone'}});
   const records=service.records.bind(service);
   // Bonjour 1.3 enumerates every adapter; advertise only this LAN endpoint.
   service.records=()=>records().filter(record=>record.type!=='AAAA'&&(record.type!=='A'||record.data===address));
   publishers.set(address,bonjour);
  }
 };
 refresh();const timer=setInterval(refresh,5000);timer.unref();
 return {destroy(){if(destroyed)return;destroyed=true;clearInterval(timer);for(const bonjour of publishers.values())stop(bonjour);publishers.clear();}};
}
module.exports={publish};
