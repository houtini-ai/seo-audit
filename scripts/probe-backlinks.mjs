import { tmpdir } from 'node:os'; import path from 'node:path'; import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { CHECKS } from '../dist/audit/checks.js';
const dbPath = path.join(tmpdir(), `sac-bl-${process.pid}.db`); rmSync(dbPath, { force: true });
const w = new AuditDatabase(dbPath); const db = w.db;
db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status) VALUES ('c1','https://x','x','completed')`).run();
const pg = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,inlink_count) VALUES (@c,@u,@k,@s,@i,@inl)`);
[['https://x/live','https://x/live',200,1,5],['https://x/dead','https://x/dead',404,0,1],['https://x/orphan','https://x/orphan',200,1,0],['https://x/orphan2','https://x/orphan2',200,1,0]]
  .forEach(([u,k,s,i,inl])=>pg.run({c:'c1',u,k,s,i,inl}));
const bl = db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains,status_code) VALUES (@k,@u,@b,@rd,@s)`);
// dead page WITH backlinks (the quick win); orphan WITH backlinks (so it's NOT a true orphan); orphan2 has none
[['https://x/dead','https://x/dead',42,9,404],['https://x/orphan','https://x/orphan',7,3,200]].forEach(([k,u,b,rd,s])=>bl.run({k,u,b,rd,s}));
let pass=0,fail=0; const chk=(n,c,d)=>{c?(pass++,console.log('  ok  '+n)):(fail++,console.log('FAIL '+n+' :: '+d));};
const run=id=>CHECKS.find(c=>c.id===id).run({db,gscMaxDate:null});
const b404=run('backlinks-to-404'); chk('backlinks-to-404 flags /dead only', b404.length===1&&b404[0].urlKey.endsWith('/dead'), JSON.stringify(b404));
chk('evidence has backlinks+status', b404[0]?.evidence.backlinks===42&&b404[0]?.evidence.status===404, JSON.stringify(b404[0]?.evidence));
const orph=run('orphan-no-links'); chk('orphan-no-links flags /orphan2 only (orphan has backlinks)', orph.length===1&&orph[0].urlKey.endsWith('/orphan2'), JSON.stringify(orph));
// gate: with empty page_backlinks, orphan-no-links returns []
db.prepare('DELETE FROM page_backlinks').run();
chk('orphan-no-links gated off when no backlinks pulled', run('orphan-no-links').length===0, 'should be 0');
w.close(); rmSync(dbPath,{force:true}); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
