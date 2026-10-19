# Local Life — Repository Engineering Contract

Before work read the current `sanchuang-dev/.github/AGENTS.md`, then this file and the active Issue/PR/task contract. Do not substitute remembered policies.

## Purpose
This repository owns **new, maintainable** local-life frontend source. React + TypeScript, Vite, Tailwind CSS, React Router are the maintainer-approved stack. The ongoing product simplification is undecided: do not assume legacy V0.3 screens must be copied wholesale.

The old `sanchuang-dev/base-prototype/demo/local-life` is the **archived-style historical presentation source** and still powers the old public `/base-prototype/local-life/` route. Until a separately approved cutover, do not modify its publishing flow, copy the same business source into two live projects, or promise feature parity.

## Branches
Follow `feat/* -> dev -> test -> prod`. `main` is the default-branch policy and workflow registration surface, **not** a deployment environment. `dev` may deploy to the separate GitHub Pages *development preview*, never claim this is `prod`. Only `prod` could become a production source under separately approved deployment rules.

## Implementation
Prefer small, typed feature modules; keep page components separate from demo data and adapters when product screens are introduced. Do not introduce APIs, sensitive personal/medical data, fake government endorsements, real payments, or production secrets. Clearly label all demo actions. Do not add navigation/features without an explicit product decision.

## Verification
Node 22 + npm. `npm ci`, `npm run check` (Oxlint, TypeScript compile, Vite build), verify internal links and visible behavior for UI work. CSS/JS bundled by Vite, base path `/local-life/`. GitHub Pages static preview uses React Router HashRouter for safe deep links. A green CI does not prove device/browser interaction; report the gap.

## Worker
Only repository-approved Organization V2 caller with exact immutable SHA and verified base `dev` may dispatch, on an authorized open Issue. Independent readonly verification and Draft PR delivery are required; model must not merge, close Issues, deploy or approve its own work. Never weaken checks merely to pass.
