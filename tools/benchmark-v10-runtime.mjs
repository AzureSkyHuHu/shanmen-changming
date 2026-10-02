import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'error'});
try{const m=await server.ssrLoadModule('/tools/benchmark-v10-runtime.ts');console.log(JSON.stringify(m.run(),null,2));}finally{await server.close();}
