const path = require('node:path');
const { getFileCategory } = require('../../core/file-security');

const values = value => String(value || '').split(',').filter(Boolean);
const key = item => `${item.year}/${item.month}/${item.filename}`;
const kind = item => {
  const category = item.category || getFileCategory(path.extname(item.filename));
  return ['image', 'audio'].includes(category) ? category : 'other';
};

/** Filter and sort the catalog before slicing, so every page uses the same global order. */
function queryCatalog(data, query) {
  const q = String(query.q || '').trim().toLowerCase();
  const folder = String(query.folder || '').trim();
  const exactKey = String(query.key || '').trim();
  const onlyProtected = query.protected === '1' || query.protected === 'true';
  const buckets = values(query.buckets), types = values(query.types);
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(query.limit, 10) || 20));
  const rawSort = String(query.sort || '').replace('-', '_');
  const sort = /^(time|name|size|hits)_(asc|desc)$/.test(rawSort) ? rawSort : 'time_desc';
  const bucketCounts = {};
  for (const item of data.images) {
    const b = `${item.year}/${item.month}`;
    bucketCounts[b] = (bucketCounts[b] || 0) + 1;
  }
  const images = data.images.filter(item => (!exactKey || key(item) === exactKey)
    && (!q || key(item).toLowerCase().includes(q))
    && (!folder || item.year === folder || `${item.year}/${item.month}` === folder)
    && (!buckets.length || buckets.includes(`${item.year}/${item.month}`))
    && (!types.length || types.includes(kind(item)))
    && (!onlyProtected || Boolean(item.locked)));
  images.sort((a, b) => {
    let difference;
    if (sort.startsWith('name_')) difference = a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
    else {
      const field = sort.startsWith('size_') ? 'size' : sort.startsWith('hits_') ? 'hits' : 'createdAt';
      difference = (a[field] || 0) - (b[field] || 0);
    }
    return (sort.endsWith('_asc') ? difference : -difference) || key(a).localeCompare(key(b));
  });
  const totalBytes = images.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  return {
    images: images.slice(offset, offset + limit),
    totalCount: images.length,
    totalBytes,
    allTotalCount: data.images.length,
    buckets: Object.keys(bucketCounts).sort().reverse(),
    bucketCounts,
    optimizationEnabled: data.optimizationEnabled
  };
}

module.exports = { queryCatalog };
