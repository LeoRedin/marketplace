// inventarch/ia-kb-kit's locator checker, the declared checks kb-check-locators and kb-check-task-locators: it checks an ia.document-locators.v1 manifest's metadata and, with --checkout, a local checkout's pinned bytes; it runs from the kit folder
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function portable(value) {
  assert(typeof value === 'string' && value && !isAbsolute(value) && !/[:\\\0]/.test(value), 'invalid relative document path');
  assert(value.split('/').every(p => p && p !== '.' && p !== '..'), 'document path traversal');
}
export function checkLocators(manifest, checkouts = {}) {
  assert(manifest && manifest.format === 'ia.document-locators.v1', 'unsupported locator format');
  assert(Object.keys(manifest).every(k => ['format','documents'].includes(k)), 'unknown locator manifest field');
  assert(Array.isArray(manifest.documents) && manifest.documents.length, 'documents must be nonempty');
  const documents = new Set(), anchors = new Set(), checked = [];
  for (const doc of manifest.documents) {
    assert(doc && Object.keys(doc).every(k => ['documentId','specIdentity','repository','commit','path','sha256'].includes(k)), 'unknown document field');
    for (const key of ['documentId','specIdentity','repository','commit','path','sha256']) assert(typeof doc[key] === 'string' && doc[key], 'missing ' + key);
    assert(!documents.has(doc.documentId) && !anchors.has(doc.specIdentity), 'duplicate canonical document or native anchor');
    documents.add(doc.documentId); anchors.add(doc.specIdentity);
    assert(/^[a-z0-9][a-z0-9._-]*$/.test(doc.repository), 'invalid repository ID');
    assert(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(doc.commit), 'commit must be an exact object ID');
    assert(/^work-system\/contract\/spec\/[^/]+$/.test(doc.specIdentity), 'expected canonical public spec identity');
    assert(/^[a-f0-9]{64}$/.test(doc.sha256), 'invalid sha256');
    portable(doc.path);
    const root = checkouts[doc.repository];
    if (!root) { checked.push({documentId:doc.documentId, standing:'metadata-only; bytes unavailable'}); continue; }
    const base = realpathSync(resolve(root)), file = realpathSync(resolve(base, doc.path)), rel = relative(base, file);
    assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'document escapes selected checkout');
    const run = args => {
      const result = spawnSync('git', ['-C',base,...args], {windowsHide:true,maxBuffer:16*1024*1024});
      assert(!result.error && result.status === 0, 'selected checkout cannot resolve pinned source');
      return result.stdout;
    };
    assert.equal(run(['rev-parse','HEAD']).toString().trim(), doc.commit, 'checkout HEAD differs from pinned commit');
    const bytes = run(['show',doc.commit + ':' + doc.path]);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), doc.sha256, 'committed body digest mismatch');
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), doc.sha256, 'working body differs from pinned bytes');
    checked.push({documentId:doc.documentId, standing:'pinned committed and working bytes verified'});
  }
  return {format:manifest.format, documents:checked, networkRequests:0, bodyDisclosure:false, nativeGraphClosure:'not evaluated'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv=process.argv.slice(2), checkouts={};
    assert(argv[0], 'usage: check-locators.mjs manifest.json [--checkout repository-id=absolute-path ...]');
    for (let i=1;i<argv.length;i++) {
      assert.equal(argv[i], '--checkout', 'unknown option');
      const value=argv[++i], at=value?.indexOf('=');
      assert(at>0 && value.slice(at+1), 'checkout must be repository-id=absolute-path');
      const id=value.slice(0,at); assert(!Object.hasOwn(checkouts,id), 'duplicate checkout ID');
      checkouts[id]=value.slice(at+1);
    }
    console.log(JSON.stringify(checkLocators(JSON.parse(readFileSync(argv[0], 'utf8')), checkouts), null, 2));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
