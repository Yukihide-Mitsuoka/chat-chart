import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const [port, buildDir, dataPrefix, tenantDir] = process.argv.slice(2);
const MIME = {".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",
  ".json":"application/json",".parquet":"application/octet-stream",".wasm":"application/wasm",
  ".svg":"image/svg+xml",".map":"application/json",".woff2":"font/woff2",".txt":"text/plain"};
function safeJoin(root, p){const n=normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/,"");const f=join(root,n);return f.startsWith(normalize(root))?f:null;}
const server = http.createServer(async (req,res)=>{
  const urlPath = req.url.split("?")[0];
  if (dataPrefix!=="-"&&urlPath.startsWith(dataPrefix)){
    const rel = urlPath.slice(dataPrefix.length);
    const file = safeJoin(tenantDir, rel);
    try{ const body=await readFile(file);
      res.writeHead(200,{"content-type":MIME[extname(file)]||"application/octet-stream","cache-control":"no-store"});
      return res.end(body);
    }catch{res.writeHead(404);return res.end("no data");}
  }
  if (/service-worker/i.test(urlPath)){res.writeHead(404);return res.end("sw disabled");}
  let file = safeJoin(buildDir, urlPath);
  try{ let s=await stat(file); if(s.isDirectory()) file=join(file,"index.html");
    const body=await readFile(file);
    res.writeHead(200,{"content-type":MIME[extname(file)]||"application/octet-stream"});
    res.end(body);
  }catch{
    try{const body=await readFile(join(buildDir,"index.html"));res.writeHead(200,{"content-type":"text/html"});res.end(body);}
    catch{res.writeHead(404);res.end("not found");}
  }
});
server.listen(Number(port), ()=>console.log(`fixed-tenant gate on :${port} -> ${tenantDir}`));
