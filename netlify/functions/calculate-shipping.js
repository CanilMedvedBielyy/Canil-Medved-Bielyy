// Esta função roda no servidor da Netlify. O token do Melhor Envio fica
// guardado como variável de ambiente (MELHORENVIO_TOKEN), configurada
// direto nas configurações do projeto na Netlify — nunca aparece no
// código do site nem no GitHub.

/* Coordenadas aproximadas do Ipiranga, São Paulo (origem dos envios) */
const ORIGIN_LAT = -23.5893;
const ORIGIN_LNG = -46.6095;
const LOCAL_DELIVERY_RADIUS_KM = 7;
const LOCAL_DELIVERY_PRICE = 20;
const LOCAL_DELIVERY_DAYS = 3;

function distanceKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* Tenta descobrir se o CEP de destino está dentro do raio de entrega
   local. Usa dois serviços públicos e gratuitos (ViaCEP + Nominatim/
   OpenStreetMap). Se qualquer etapa falhar, simplesmente não oferece
   a entrega local — não quebra o restante do cálculo de frete.
   TEMPORÁRIO: retorna também um objeto "debug" pra diagnosticar. */
async function checkLocalDelivery(cep){
  const debug = { cep };
  try{
    const viacepRes = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const viacep = await viacepRes.json();
    debug.viacep = viacep;
    if(viacep.erro) return { option: null, debug };

    const query = `${viacep.logradouro}, ${viacep.bairro}, ${viacep.localidade}, ${viacep.uf}, Brasil`;
    debug.query = query;
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Medved Bielyy (medvedbielyy@outlook.com)' }
    });
    debug.geoStatus = geoRes.status;
    const geoData = await geoRes.json();
    debug.geoData = geoData;
    if(!geoData || !geoData[0]) return { option: null, debug };

    const lat = parseFloat(geoData[0].lat);
    const lng = parseFloat(geoData[0].lon);
    const dist = distanceKm(ORIGIN_LAT, ORIGIN_LNG, lat, lng);
    debug.lat = lat; debug.lng = lng; debug.distKm = dist;

    if(dist <= LOCAL_DELIVERY_RADIUS_KM){
      return {
        option: {
          name: 'Entrega local (motoboy)',
          company: null,
          price: LOCAL_DELIVERY_PRICE,
          delivery_time: LOCAL_DELIVERY_DAYS,
          local: true
        },
        debug
      };
    }
    return { option: null, debug };
  } catch(err){
    debug.error = err.message;
    return { option: null, debug };
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Método não permitido' })
    };
  }

  const TOKEN = process.env.MELHORENVIO_TOKEN;
  if (!TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Token do Melhor Envio não configurado no servidor (variável MELHORENVIO_TOKEN ausente).' })
    };
  }

  try {
    const payload = JSON.parse(event.body);

    const body = {
      from: { postal_code: payload.from_postal_code },
      to: { postal_code: payload.to_postal_code },
      products: payload.products
    };

    const [meResponse, localResult] = await Promise.all([
      fetch('https://www.melhorenvio.com.br/api/v2/me/shipment/calculate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${TOKEN}`,
          'User-Agent': 'Medved Bielyy (medvedbielyy@outlook.com)'
        },
        body: JSON.stringify(body)
      }),
      checkLocalDelivery(payload.to_postal_code)
    ]);

    const data = await meResponse.json();

    if (!meResponse.ok) {
      return {
        statusCode: meResponse.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Melhor Envio recusou o pedido', details: data })
      };
    }

    // A API retorna uma lista com todas as transportadoras/serviços.
    // Filtramos só as opções que realmente deram cotação (sem erro).
    let options = Array.isArray(data) ? data.filter(o => !o.error && o.price) : [];

    if(localResult && localResult.option){
      options = [localResult.option, ...options];
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options, localDebug: localResult ? localResult.debug : null })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Erro ao calcular frete', details: err.message })
    };
  }
};
