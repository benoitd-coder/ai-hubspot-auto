# Sales Copilot Brief Worker

Async worker for full-quality Call Prep briefs.

## Runtime

- Cloud Run service with `min-instances=0`
- Firestore for job/cache storage
- Cloud Tasks for background execution
- Gemini Flash-Lite by default

## Required environment variables

```bash
WORKER_API_KEY=...
GEMINI_API_KEY=...
GCP_PROJECT=dogwood-method-256009
TASKS_LOCATION=europe-west1
TASKS_QUEUE=sales-copilot-briefs
CACHE_TTL_HOURS=24
```

`PUBLIC_BASE_URL` is optional. If omitted, the service derives it from the request host when enqueueing a task.
