// Netlify Function: salva mudanças de produtos feitas no painel admin (protegida por senha)
// POST { password, op, ... }
//   op 'update' : { id, patch }       -> estoque, preço, nome, descrição, categoria, esgotado, oculto, encomenda...
//   op 'add'    : { product }         -> cadastra produto novo
//   op 'remove' : { id }              -> apaga um produto cadastrado pelo painel
//   op 'reset'  : { id }              -> desfaz as alterações de um produto do site (volta ao original)
//   op 'photo'  : { id, dataUrl }     -> troca/coloca a foto (vale para qualquer produto)
const crypto = require('crypto');
const { blobStore } = require('../lib/blobs');
const { getDoc, saveDoc } = require('../lib/catalog');

function isAdmin(event, bodyPassword) {
  const given = (event.headers && (event.headers['x-admin-password'] || event.headers['X-Admin-Password'])) || bodyPassword || '';
  const real = process.env.ADMIN_PASSWORD || '';
  if (!given || !real) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

const txt = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n);
const money = (v) => { const n = Math.round(Number(String(v).replace(',', '.')) * 100) / 100; return n > 0 && n < 100000 ? n : null; };
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, Math.min(99999, n)) : null; };

function cleanVariants(list) {
  if (!Array.isArray(list)) return null;
  const out = list.slice(0, 20).map(v => ({
    label: txt(v.label, 60) || 'Único',
    cartao: money(v.cartao),
    pix: money(v.pix),
    available: v.available !== false
  })).filter(v => v.cartao);
  out.forEach(v => { if (!v.pix) v.pix = v.cartao; });
  return out.length ? out : null;
}

// só deixa passar campos conhecidos
function cleanPatch(p) {
  const o = {};
  if (!p || typeof p !== 'object') return o;
  if ('stock' in p) { const s = int(p.stock); if (s !== null) { o.stock = s; o.sold = 0; } }
  if ('soldOut' in p) o.soldOut = !!p.soldOut;
  if ('hidden' in p) o.hidden = !!p.hidden;
  if ('preorder' in p) o.preorder = !!p.preorder;
  if ('name' in p && txt(p.name, 140)) o.name = txt(p.name, 140);
  if ('desc' in p) o.desc = txt(p.desc, 1200);
  if ('brand' in p && txt(p.brand, 60)) o.brand = txt(p.brand, 60);
  if ('category' in p && txt(p.category, 60)) o.category = txt(p.category, 60);
  if ('variants' in p) { const v = cleanVariants(p.variants); if (v) o.variants = v; }
  if ('cost' in p) { const c = money(p.cost); o.cost = c; }
  return o;
}

async function savePhoto(event, id, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Foto inválida');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 1.5 * 1024 * 1024) throw new Error('Foto grande demais');
  const key = `p${id}_${Date.now().toString(36)}`;
  await blobStore('product-photos', event).set(key, buf, { metadata: { type: 'image/' + m[1] } });
  return key;
}

// O Netlify Blobs pode devolver uma cópia de até ~1 minuto atrás logo depois de um salvamento.
// O painel manda junto a versão mais nova que ele tem (base); se ela for mais nova que a lida, usamos ela.
function pickNewest(doc, base) {
  if (!base || typeof base !== 'object') return doc;
  if (!(Number(base.v) > Number(doc.v || 0))) return doc;
  if (typeof base.products !== 'object' || typeof base.added !== 'object' || !base.products || !base.added) return doc;
  return { products: base.products, added: base.added, v: Number(base.v), updatedAt: base.updatedAt || doc.updatedAt };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Método não permitido' }) };
  if ((event.body || '').length > 2600000) return { statusCode: 413, body: JSON.stringify({ error: 'Arquivo grande demais' }) };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido' }) }; }
  if (!isAdmin(event, body.password)) return { statusCode: 401, body: JSON.stringify({ error: 'Senha incorreta' }) };

  try {
    const doc = pickNewest(await getDoc(event), body.base);
    const id = String(body.id || (body.product && body.product.id) || '').replace(/\D/g, '').slice(0, 9);

    if (body.op === 'update') {
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Produto inválido' }) };
      const patch = cleanPatch(body.patch);
      if (doc.added[id]) {
        // produto cadastrado pelo painel: altera direto nele
        const a = doc.added[id];
        Object.assign(a, patch);
        if ('stock' in patch) { delete a.sold; doc.products[id] = Object.assign(doc.products[id] || {}, { stock: patch.stock, sold: 0 }); }
      } else {
        doc.products[id] = Object.assign(doc.products[id] || {}, patch);
      }
    } else if (body.op === 'add') {
      const p = body.product || {};
      const patch = cleanPatch(p);
      if (!patch.name || !patch.variants) return { statusCode: 400, body: JSON.stringify({ error: 'Preencha o nome e o preço' }) };
      const used = new Set(Object.keys(doc.added).map(Number));
      let newId = Number(id) >= 5000 ? Number(id) : 5000;
      while (used.has(newId)) newId++;
      const prod = Object.assign({ id: newId, brand: patch.brand || 'Bielyy', category: patch.category || 'Brinquedos', desc: patch.desc || '', preorder: !!patch.preorder, createdAt: new Date().toISOString() }, patch);
      delete prod.sold;
      if (body.dataUrl) prod.photo = await savePhoto(event, newId, body.dataUrl);
      doc.added[String(newId)] = prod;
      if ('stock' in patch) doc.products[String(newId)] = { stock: patch.stock, sold: 0 };
      await saveDoc(doc, event);
      return { statusCode: 200, body: JSON.stringify({ success: true, id: newId, doc }) };
    } else if (body.op === 'remove') {
      if (!doc.added[id]) return { statusCode: 400, body: JSON.stringify({ error: 'Só dá para apagar produtos cadastrados pelo painel. Para os outros, use "Ocultar do site".' }) };
      const ph = doc.added[id].photo;
      delete doc.added[id]; delete doc.products[id];
      if (ph) { try { await blobStore('product-photos', event).delete(ph); } catch (e) { /* ignora */ } }
    } else if (body.op === 'reset') {
      delete doc.products[id];
    } else if (body.op === 'photo') {
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Produto inválido' }) };
      const key = await savePhoto(event, id, body.dataUrl);
      const target = doc.added[id] || (doc.products[id] = doc.products[id] || {});
      const old = target.photo;
      target.photo = key;
      if (old && /^p\d+_/.test(old)) { try { await blobStore('product-photos', event).delete(old); } catch (e) { /* ignora */ } }
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Operação inválida' }) };
    }

    await saveDoc(doc, event);
    return { statusCode: 200, body: JSON.stringify({ success: true, doc }) };
  } catch (err) {
    console.error('Erro ao salvar catálogo:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro ao salvar: ' + err.message }) };
  }
};
