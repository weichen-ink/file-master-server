const test=require('node:test');
const assert=require('node:assert/strict');
const {queryCatalog}=require('../src/modules/image-host/catalog-query');
const images=Array.from({length:65},(_,i)=>({filename:`file-${i}.${i%3===0?'mp3':'png'}`,year:'2026',month:i<30?'10':'11',createdAt:i,size:100-i,hits:i%5}));
const catalog={images,optimizationEnabled:true};

test('Catalog pages use global ordering, disjoint batches and complete folder facets',()=>{
  const before=[...images],first=queryCatalog(catalog,{limit:'20'}),second=queryCatalog(catalog,{limit:'20',offset:'20'});
  assert.equal(first.totalCount,65);assert.equal(first.images.length,20);
  assert.equal(first.images[0].createdAt,64);assert.equal(second.images[0].createdAt,44);
  assert.ok(!first.images.some(item=>second.images.includes(item)));
  assert.deepEqual(first.buckets,['2026/11','2026/10']);assert.deepEqual(images,before);
});

test('Search and multi-select filters apply before pagination, with global sort in both directions',()=>{
  const result=queryCatalog(catalog,{q:'file-',types:'image',buckets:'2026/10,2026/11',sort:'size_asc',limit:'5',offset:'5'});
  const expected=images.filter(item=>item.filename.endsWith('.png')).sort((a,b)=>a.size-b.size);
  assert.equal(result.totalCount,expected.length);assert.deepEqual(result.images,expected.slice(5,10));
  for(const field of ['name','time','size','hits']){
    const asc=queryCatalog(catalog,{sort:`${field}_asc`,limit:100}).images;
    const desc=queryCatalog(catalog,{sort:`${field}_desc`,limit:100}).images;
    const value=item=>field==='name'?item.filename:field==='time'?item.createdAt:item[field];
    assert.ok(value(asc[0])<=value(asc.at(-1)));assert.ok(value(desc[0])>=value(desc.at(-1)));
  }
  assert.equal(queryCatalog(catalog,{q:'missing'}).totalCount,0);
  assert.equal(queryCatalog(catalog,{offset:'100'}).images.length,0);
});
