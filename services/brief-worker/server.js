import crypto from 'node:crypto';
import express from 'express';
import hubspot from '@hubspot/api-client';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import { CloudTasksClient } from '@google-cloud/tasks';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8080;
const WORKER_API_KEY = mustEnv('WORKER_API_KEY');
const GEMINI_API_KEY = mustEnv('GEMINI_API_KEY');
const GCP_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
const TASKS_LOCATION = process.env.TASKS_LOCATION || 'europe-west1';
const TASKS_QUEUE = process.env.TASKS_QUEUE || 'sales-copilot-briefs';
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 24);

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60000);
const ENGAGEMENT_LOOKBACK_DAYS = Number(process.env.ENGAGEMENT_LOOKBACK_DAYS || 180);
const MAX_ENGAGEMENTS = Number(process.env.MAX_ENGAGEMENTS || 40);
const MAX_NOTE_CHARS = Number(process.env.MAX_NOTE_CHARS || 1200);
const MAX_ASSOCIATED_CONTACTS = Number(process.env.MAX_ASSOCIATED_CONTACTS || 15);
const MAX_ASSOCIATED_DEALS = Number(process.env.MAX_ASSOCIATED_DEALS || 15);

const firestore = new Firestore({ projectId: GCP_PROJECT });
const tasks = new CloudTasksClient();

const jobs = firestore.collection('sales_copilot_brief_jobs');
const cache = firestore.collection('sales_copilot_brief_cache');

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    synthese: { type: 'string' },
    etat: { type: 'string' },
    points_ouverts: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    a_eviter: { type: 'array', items: { type: 'string' } },
  },
  required: ['synthese', 'etat', 'points_ouverts', 'questions', 'a_eviter'],
};

const SYSTEM_PROMPT = `Tu es un assistant commercial senior pour SideCare, courtier en assurance santé collective et individuelle pour TPE/PME.
Tu prépares un brief de call complet, utile à un sales expérimenté, en français.

Règles :
- Reste factuel et actionnable.
- Synthèse courte, maximum 4 lignes.
- "Où on en est" doit citer le stage, le contexte commercial, le dernier signal CRM et l'enjeu probable.
- "Points ouverts" doit lister les zones à clarifier avant ou pendant le call.
- "Questions à poser" doit être contextualisé à l'entreprise, au deal et aux signaux CRM.
- "À éviter" doit identifier les risques de conversation, angles morts et sujets sensibles.
- Si une donnée manque, dis-le explicitement. N'invente jamais.`;

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/brief-jobs', requireApiKey, async (req, res) => {
  const { objectId, objectType, objectTypeId, force = false, requestedBy = null, hubspotAccessToken } = req.body || {};
  if (!objectId) {
    return res.status(400).json({ error: 'objectId is required' });
  }
  if (!hubspotAccessToken) {
    return res.status(400).json({ error: 'hubspotAccessToken is required' });
  }

  const normalizedType = normalizeObjectType(objectType, objectTypeId);
  const cacheKey = `${normalizedType}:${objectId}`;

  if (!force) {
    const cached = await readFreshCache(cacheKey);
    if (cached) {
      return res.json({ status: 'done', source: 'cache', brief: cached.brief, generatedAt: cached.generatedAt });
    }
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await jobs.doc(jobId).set({
    id: jobId,
    status: 'queued',
    objectId: String(objectId),
    objectType: normalizedType,
    cacheKey,
    hubspotAccessToken,
    requestedBy,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  });

  await enqueueJob(req, jobId);
  res.status(202).json({ status: 'queued', jobId });
});

app.get('/api/brief-jobs/:jobId', requireApiKey, async (req, res) => {
  const snap = await jobs.doc(req.params.jobId).get();
  if (!snap.exists) {
    return res.status(404).json({ error: 'job not found' });
  }

  const job = snap.data();
  res.json({
    jobId: job.id,
    status: job.status,
    brief: job.brief || null,
    error: job.error || null,
    generatedAt: job.generatedAt || null,
    updatedAt: job.updatedAt || null,
  });
});

app.post('/api/brief-jobs/:jobId/run', requireApiKey, async (req, res) => {
  const jobRef = jobs.doc(req.params.jobId);
  const snap = await jobRef.get();
  if (!snap.exists) {
    return res.status(404).json({ error: 'job not found' });
  }

  const job = snap.data();
  if (job.status === 'done') {
    return res.json({ status: 'done' });
  }

  await jobRef.update({
    status: 'running',
    updatedAt: new Date().toISOString(),
    attempts: FieldValue.increment(1),
  });

  try {
    const hsClient = new hubspot.Client({ accessToken: job.hubspotAccessToken });
    const hubspotContext = await fetchHubspotContext(hsClient, job.objectType, job.objectId);
    const brief = await callGemini(buildUserPrompt(hubspotContext));
    const generatedAt = new Date().toISOString();

    await Promise.all([
      jobRef.update({
        status: 'done',
        brief,
        generatedAt,
        updatedAt: generatedAt,
        contextStats: {
          contacts: hubspotContext.contacts.length,
          deals: hubspotContext.deals.length,
          engagements: hubspotContext.engagements.length,
        },
      }),
      cache.doc(job.cacheKey).set({
        brief,
        generatedAt,
        cacheKey: job.cacheKey,
      }),
    ]);

    res.json({ status: 'done' });
  } catch (e) {
    const message = e?.message || String(e);
    await jobRef.update({
      status: 'error',
      error: message,
      updatedAt: new Date().toISOString(),
    });
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`brief-worker listening on ${PORT}`);
});

function requireApiKey(req, res, next) {
  const key = req.get('x-api-key');
  if (!WORKER_API_KEY || key !== WORKER_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

async function enqueueJob(req, jobId) {
  if (!GCP_PROJECT) throw new Error('GCP_PROJECT is required');

  const queuePath = tasks.queuePath(GCP_PROJECT, TASKS_LOCATION, TASKS_QUEUE);
  const forwardedProto = req.get('x-forwarded-proto') || 'https';
  const baseUrl = process.env.PUBLIC_BASE_URL || `${forwardedProto}://${req.get('host')}`;

  await tasks.createTask({
    parent: queuePath,
    task: {
      httpRequest: {
        httpMethod: 'POST',
        url: `${baseUrl}/api/brief-jobs/${jobId}/run`,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': WORKER_API_KEY,
        },
        body: Buffer.from(JSON.stringify({ jobId })).toString('base64'),
      },
    },
  });
}

async function readFreshCache(cacheKey) {
  const snap = await cache.doc(cacheKey).get();
  if (!snap.exists) return null;

  const value = snap.data();
  const generatedAt = value.generatedAt ? new Date(value.generatedAt).getTime() : 0;
  const maxAgeMs = CACHE_TTL_HOURS * 60 * 60 * 1000;
  if (Date.now() - generatedAt > maxAgeMs) return null;
  return value;
}

function normalizeObjectType(objectType, objectTypeId) {
  const raw = String(objectType || objectTypeId || '').toLowerCase();
  if (['company', 'companies', '0-2'].includes(raw)) return 'company';
  if (['deal', 'deals', '0-3'].includes(raw)) return 'deal';
  return 'contact';
}

async function fetchHubspotContext(hsClient, objectType, objectId) {
  if (objectType === 'company') return fetchCompanyContext(hsClient, objectId);
  if (objectType === 'deal') return fetchDealContext(hsClient, objectId);
  return fetchContactContext(hsClient, objectId);
}

async function fetchContactContext(hsClient, contactId) {
  const contact = await hsClient.crm.contacts.basicApi.getById(
    contactId,
    ['firstname', 'lastname', 'jobtitle', 'company', 'email', 'phone', 'mobilephone', 'lifecyclestage', 'hs_lead_status', 'last_activity_date', 'createdate'],
    undefined,
    ['companies', 'deals'],
  );

  const companyId = contact.associations?.companies?.results?.[0]?.id;
  const dealIds = (contact.associations?.deals?.results || []).map((r) => r.id);
  const [company, deals, engagements] = await Promise.all([
    companyId ? safeFetch(() => fetchCompany(hsClient, companyId), null) : Promise.resolve(null),
    safeFetch(() => fetchDeals(hsClient, dealIds), []),
    safeFetch(() => fetchEngagements(hsClient, 'contact', contactId), []),
  ]);

  return {
    target: { type: 'contact', id: contactId },
    contact: { id: contact.id, ...contact.properties },
    contacts: [],
    company,
    deals,
    engagements,
  };
}

async function fetchCompanyContext(hsClient, companyId) {
  const company = await hsClient.crm.companies.basicApi.getById(
    companyId,
    ['name', 'domain', 'phone', 'industry', 'numberofemployees', 'annualrevenue', 'lifecyclestage', 'createdate', 'description'],
    undefined,
    ['contacts', 'deals'],
  );

  const contactIds = (company.associations?.contacts?.results || []).map((r) => r.id);
  const dealIds = (company.associations?.deals?.results || []).map((r) => r.id);
  const [contacts, deals, engagements] = await Promise.all([
    safeFetch(() => fetchContacts(hsClient, contactIds), []),
    safeFetch(() => fetchDeals(hsClient, dealIds), []),
    safeFetch(() => fetchEngagements(hsClient, 'company', companyId), []),
  ]);

  return {
    target: { type: 'company', id: companyId },
    contact: contacts[0] || null,
    contacts,
    company: { id: company.id, ...company.properties },
    deals,
    engagements,
  };
}

async function fetchDealContext(hsClient, dealId) {
  const deal = await hsClient.crm.deals.basicApi.getById(
    dealId,
    [
      'dealname', 'amount', 'dealstage', 'closedate', 'pipeline', 'hubspot_owner_id', 'createdate',
      'num_associated_contacts', 'notes_last_updated', 'notes_last_contacted', 'hs_lastmodifieddate',
      'need__pro', 'competition__pro', 'authority__pro', 'timing__pro', 'nombre_de_salaries',
      'courtier_actuel', 'logiciel_de_paie_utilise', 'sirh_utilise', 'produit', 'canal',
    ],
    undefined,
    ['contacts', 'companies'],
  );

  const contactIds = (deal.associations?.contacts?.results || []).map((r) => r.id);
  const companyId = deal.associations?.companies?.results?.[0]?.id;
  const [contacts, company, engagements] = await Promise.all([
    safeFetch(() => fetchContacts(hsClient, contactIds), []),
    companyId ? safeFetch(() => fetchCompany(hsClient, companyId), null) : Promise.resolve(null),
    safeFetch(() => fetchEngagements(hsClient, 'deal', dealId), []),
  ]);

  return {
    target: { type: 'deal', id: dealId },
    contact: contacts[0] || null,
    contacts,
    company,
    deals: [{ id: deal.id, ...deal.properties }],
    engagements,
  };
}

async function fetchCompany(hsClient, companyId) {
  const company = await hsClient.crm.companies.basicApi.getById(companyId, [
    'name', 'domain', 'phone', 'industry', 'numberofemployees', 'annualrevenue', 'lifecyclestage', 'createdate', 'description',
  ]);
  return { id: company.id, ...company.properties };
}

async function fetchContacts(hsClient, contactIds) {
  if (!contactIds.length) return [];
  const props = ['firstname', 'lastname', 'jobtitle', 'company', 'email', 'phone', 'mobilephone', 'lifecyclestage', 'hs_lead_status', 'last_activity_date'];
  const results = await Promise.all(
    contactIds.slice(0, MAX_ASSOCIATED_CONTACTS).map((id) =>
      hsClient.crm.contacts.basicApi.getById(id, props).catch(() => null)
    ),
  );
  return results.filter(Boolean).map((c) => ({ id: c.id, ...c.properties }));
}

async function fetchDeals(hsClient, dealIds) {
  if (!dealIds.length) return [];
  const props = [
    'dealname', 'amount', 'dealstage', 'closedate', 'pipeline', 'hubspot_owner_id', 'createdate',
    'need__pro', 'competition__pro', 'authority__pro', 'timing__pro', 'nombre_de_salaries',
    'courtier_actuel', 'produit', 'canal',
  ];
  const results = await Promise.all(
    dealIds.slice(0, MAX_ASSOCIATED_DEALS).map((id) =>
      hsClient.crm.deals.basicApi.getById(id, props).catch(() => null)
    ),
  );
  return results.filter(Boolean).map((d) => ({ id: d.id, ...d.properties }));
}

async function fetchEngagements(hsClient, associationType, objectId) {
  const since = Date.now() - ENGAGEMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const types = [
    { kind: 'notes', api: hsClient.crm.objects.notes, props: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id'] },
    { kind: 'calls', api: hsClient.crm.objects.calls, props: ['hs_call_title', 'hs_call_body', 'hs_timestamp', 'hs_call_outcome'] },
    { kind: 'emails', api: hsClient.crm.objects.emails, props: ['hs_email_subject', 'hs_email_text', 'hs_timestamp'] },
    { kind: 'meetings', api: hsClient.crm.objects.meetings, props: ['hs_meeting_title', 'hs_meeting_body', 'hs_timestamp'] },
  ];

  const resultsByType = await Promise.all(types.map(async (t) => {
    try {
      const res = await t.api.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: `associations.${associationType}`, operator: 'EQ', value: objectId },
            { propertyName: 'hs_timestamp', operator: 'GTE', value: String(since) },
          ],
        }],
        properties: t.props,
        sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
        limit: 20,
      });
      return (res.results || []).map((r) => ({
        kind: t.kind,
        timestamp: r.properties.hs_timestamp,
        ...truncateStringValues(r.properties),
      }));
    } catch (e) {
      console.log(`Skipping ${t.kind}: ${e.message || String(e)}`);
      return [];
    }
  }));

  return resultsByType
    .flat()
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, MAX_ENGAGEMENTS);
}

function truncateStringValues(props) {
  return Object.fromEntries(Object.entries(props).map(([key, value]) => {
    if (typeof value === 'string' && value.length > MAX_NOTE_CHARS) {
      return [key, `${value.slice(0, MAX_NOTE_CHARS)}... [tronque]`];
    }
    return [key, value];
  }));
}

function buildUserPrompt({ target, contact, contacts, company, deals, engagements }) {
  return `Prépare le brief commercial complet.

MAILLE CRM: ${target.type}
ID CRM: ${target.id}

CONTACT PRINCIPAL:
${JSON.stringify(contact)}

CONTACTS LIES (${contacts.length}):
${JSON.stringify(contacts)}

ENTREPRISE:
${JSON.stringify(company)}

DEALS LIES (${deals.length}):
${JSON.stringify(deals)}

ACTIVITES RECENTES (${engagements.length}, ${ENGAGEMENT_LOOKBACK_DAYS}j):
${JSON.stringify(engagements)}

Retourne uniquement un JSON strict conforme au schema.`;
}

async function callGemini(userPrompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: BRIEF_SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 2500,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned an empty response');
    return parseJson(text);
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw e;
  }
}

async function safeFetch(fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    console.log(`Optional fetch skipped: ${e.message || String(e)}`);
    return fallback;
  }
}

function mustEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
