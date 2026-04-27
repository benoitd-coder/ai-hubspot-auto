# Sales Copilot — HubSpot UI Extension

Assistant commercial IA pour l'équipe sales SideCare/LOUNNA, embarqué nativement dans HubSpot.

## Modules

1. **Call Prep** *(en cours)* — App Card sur fiches Contact et Deal qui génère un brief de call contextualisé.
2. **Pipe Review** *(à venir)* — App Page custom avec deals à risque, à accélérer, anomalies, synthèse hebdo.
3. **Note Capture** *(à venir)* — App Card sur fiche Deal qui parse un brouillon et propose des updates HubSpot avec diff.

## Stack

- HubSpot Developer Platform `2026.03` (Projects + UI Extensions + App Functions)
- Google Gemini 2.5 Flash (IA)
- HubSpot API client (récupération contexte CRM)

## Setup local

```bash
# 1. Auth HubSpot (compte LOUNNA)
hs init
hs auth

# 2. Installer les deps de chaque sous-module
cd src/app/cards && npm install && cd -
cd src/app/functions && npm install && cd -

# 3. Configurer le secret Gemini côté HubSpot
hs secret add GEMINI_API_KEY

# 4. Lancer le dev local
hs project dev
```

## Structure

```
ai-hubspot-auto/
├── hsproject.json                       # Manifest projet (platformVersion 2026.03)
└── src/app/
    ├── app-hsmeta.json                  # Manifest app privée + scopes + permittedUrls
    ├── cards/
    │   ├── call-prep-card-hsmeta.json   # Manifest App Card "Call Prep"
    │   ├── CallPrepCard.tsx             # UI React
    │   ├── package.json
    │   └── tsconfig.json
    └── functions/
        ├── generate-call-brief-hsmeta.json   # Manifest App Function + secrets
        ├── generateCallBrief.js              # Logique serverless (mock → Gemini)
        └── package.json
```

## Roadmap

- [x] Sprint 1 — Skeleton (mock brief)
- [ ] Sprint 1 — Brancher Gemini 2.5 Flash + contexte HubSpot
- [ ] Sprint 1 — Cache 6h + bouton "Sauvegarder comme note"
- [ ] Sprint 2 — Pipe Review (App Page)
- [ ] Sprint 3 — Note Capture (App Card + diff UI)

## Sécurité / RGPD

- Toutes les données client transitent par Gemini sous contrat Google Workspace (à vérifier ZDR).
- Audit trail des écritures HubSpot dans une custom property dédiée (Sprint 3).
- Scopes HubSpot scopés au strict nécessaire dans `app-hsmeta.json`.
