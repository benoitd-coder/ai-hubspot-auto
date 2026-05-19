// Sales Copilot — generate-call-brief
// Proxy HubSpot court vers le worker async. La génération IA longue ne tourne pas dans HubSpot.

const BACKEND_TIMEOUT_MS = 8000;

exports.main = async (context = {}) => {
  const params = context.parameters || {};
  const action = params.action || 'start';
  const backendUrl = process.env.BRIEF_WORKER_URL;
  const apiKey = process.env.BRIEF_WORKER_API_KEY;

  if (!backendUrl || !apiKey) {
    return {
      error: 'BRIEF_WORKER_URL ou BRIEF_WORKER_API_KEY non configuré côté HubSpot.',
    };
  }

  try {
    const hubspotAccessToken = context.secrets?.PRIVATE_APP_ACCESS_TOKEN || process.env.PRIVATE_APP_ACCESS_TOKEN;
    if (!hubspotAccessToken) {
      return { error: 'Token HubSpot privé indisponible dans la fonction.' };
    }

    if (action === 'status') {
      if (!params.jobId) return { error: 'jobId manquant.' };
      return await callBackend(`${backendUrl}/api/brief-jobs/${params.jobId}`, {
        method: 'GET',
        apiKey,
      });
    }

    return await callBackend(`${backendUrl}/api/brief-jobs`, {
      method: 'POST',
      apiKey,
      body: {
        objectId: params.objectId || params.contactId,
        objectType: params.objectType,
        objectTypeId: params.objectTypeId,
        force: Boolean(params.force),
        requestedBy: context.userEmail || context.userId || null,
        hubspotAccessToken,
      },
    });
  } catch (e) {
    return { error: e.message || String(e) };
  }
};

async function callBackend(url, { method, apiKey, body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    const payload = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(payload.error || `Worker ${res.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}
