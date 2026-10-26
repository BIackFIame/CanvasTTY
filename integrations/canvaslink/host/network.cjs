const os=require('node:os'),fs=require('node:fs');
const {privateAddress}=require('./security.cjs');

function physicalInterface(name,seen=new Set()){
 if(seen.has(name))return false;seen.add(name);
 const root='/sys/class/net/'+name;
 try{
  if(fs.readFileSync(root+'/operstate','utf8').trim()==='down')return false;
  if(fs.existsSync(root+'/device'))return true;
  return fs.readdirSync(root).some(link=>link.startsWith('lower_')&&physicalInterface(link.slice(6),seen));
 }catch{return false;}
}
function lanAddresses(){
 const addresses=[];
 for(const [name,entries] of Object.entries(os.networkInterfaces())){
  if(process.platform==='linux'){
   if(!physicalInterface(name))continue;
  }else if(/^(?:lo\d*$|utun|tun|tap|ppp|ipsec|docker|veth|virbr|vEthernet|vmnet|vboxnet)|vpn|wireguard|tailscale|zerotier|happ/i.test(name))continue;
  for(const entry of entries||[]){
   if((entry.family==='IPv4'||entry.family===4)&&!entry.internal&&privateAddress(entry.address))addresses.push(entry.address);
  }
 }
 return [...new Set(addresses)].sort();
}
module.exports={lanAddresses};
