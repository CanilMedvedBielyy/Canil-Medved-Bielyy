// Esta função roda no servidor da Netlify. O token do Melhor Envio fica
// guardado como variável de ambiente (MELHORENVIO_TOKEN), configurada
// direto nas configurações do projeto na Netlify — nunca aparece no
// código do site nem no GitHub.

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

    const response = await fetch('https://www.melhorenvio.com.br/api/v2/me/shipment/calculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'User-Agent': 'Medved Bielyy (medvedbielyy@outlook.com)'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Melhor Envio recusou o pedido', details: data })
      };
    }

    // A API retorna uma lista com todas as transportadoras/serviços.
    // Filtramos só as opções que realmente deram cotação (sem erro).
    const options = Array.isArray(data) ? data.filter(o => !o.error && o.price) : [];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Erro ao calcular frete', details: err.message })
    };
  }
};
