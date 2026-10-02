import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'error'});
try{const m=await server.ssrLoadModule('/tools/benchmark-v10-runtime.ts');console.log(JSON.stringify(process.argv.includes('--owned')?m.runOwnedPipeline():process.argv.includes('--active')?m.runPrivate(true):process.argv.includes('--private')?m.runPrivate():m.run(),null,2));}finally{await server.close();}
