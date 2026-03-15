# GICS v1.3.3 — Production Plan (Bootstrap)

> Propósito: establecer el runbook mínimo para arrancar la implementación de v1.3.3 sobre una base documental saneada.

**Estado:** Preparación inicial  
**Rama de trabajo:** `dev/v1.3.3`  
**Fecha:** 2026-03-15

---

## 1) Objetivo de esta fase

Dejar preparado el entorno de trabajo para que el desarrollo de 1.3.3 empiece sin ambigüedad entre:

- documentación histórica (legacy), y
- documentación activa (source of truth).

---

## 2) Invariantes operativas

1. No se elimina documentación histórica; se **depreca y referencia**.
2. Toda nueva implementación se planifica contra docs 1.3.3.
3. El trabajo técnico se realiza en `dev/v1.3.3`.
4. Mantener gates estándar para cada fase técnica:
   - `npm run build`
   - `npm test`
   - `npm run verify`
   - `npm run bench` (si aplica)

---

## 3) Checklist de arranque (v1.3.3 prep)

- [x] Crear rama `dev/v1.3.3`.
- [x] Publicar ledger de deprecación documental (`docs/DEPRECATIONS_v1_3_3.md`).
- [x] Marcar docs de 1.3.2 como legacy para nueva planificación.
- [x] Crear roadmap base `docs/roadmaps/GICS_ROADMAP_v1_3_3.md`.
- [x] Actualizar referencias de versión en `README.md` y `docs/VERSIONING.md`.

---

## 4) Próxima fase (definición técnica)

Pendiente de definir en siguiente iteración:

- objetivos funcionales de 1.3.3,
- alcance por fases,
- criterios de aceptación por feature,
- plan de pruebas y benchmarks asociados.

---

## 5) Trazabilidad

- **Versionado:** `docs/VERSIONING.md`
- **Deprecación:** `docs/DEPRECATIONS_v1_3_3.md`
- **Roadmap activo:** `docs/roadmaps/GICS_ROADMAP_v1_3_3.md`
