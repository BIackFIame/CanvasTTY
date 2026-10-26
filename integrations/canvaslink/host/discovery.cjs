const {spawn}=require('node:child_process');
// macOS mDNSResponder owns multicast publication. UDP-only JS Bonjour can
// report "up" while its records remain invisible to native DNS-SD browsers.
function publish({name,port,ipv4,embedded=false}){
 if(process.platform==='darwin'){
   const child=spawn('/usr/bin/dns-sd',['-R',name,'_canvaslink._tcp','local.',String(port),'v=2','ipv4='+ipv4,'host='+(embedded?'canvastty':'standalone')],{stdio:'ignore'});
   child.on('error',()=>{});
   return {destroy(){child.kill('SIGTERM');}};
 }
 const {Bonjour}=require('bonjour-service'),bonjour=new Bonjour();bonjour.publish({name,type:'canvaslink',port,txt:{v:'2',ipv4,host:embedded?'canvastty':'standalone'}});return bonjour;
}
module.exports={publish};
