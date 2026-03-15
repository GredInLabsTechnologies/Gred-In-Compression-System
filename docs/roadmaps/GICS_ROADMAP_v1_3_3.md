# GICS v1.3.3 — Roadmap (Preparation)

**Fecha:** 2026-03-15T22:40:00+01:00  
**Versión objetivo:** 1.3.3  
**Estado:** En preparación  
**Rama objetivo:** `dev/v1.3.3`

---

## Objetivo del ciclo 1.3.3

Preparar la siguiente iteración de GICS con una base documental limpia, sin ambigüedades entre material histórico y material activo de ejecución.

Esta hoja de ruta define el arranque de trabajo para 1.3.3 y reemplaza como guía activa a los roadmaps del ciclo 1.3.2.

---

## Alcance inicial (bootstrap)

1. **Transición documental**
   - Marcar documentación <= v1.3.2 como legacy para nuevos trabajos.
   - Mantener trazabilidad histórica sin eliminar evidencia previa.

2. **Preparación de rama**
   - Consolidar `dev/v1.3.3` como rama base para planificación/implementación.

3. **Marco de planificación 1.3.3**
   - Dejar activos los documentos base (roadmap + production plan + ledger de deprecación).

---

## Entregables mínimos de preparación

- `docs/DEPRECATIONS_v1_3_3.md`
- `docs/roadmaps/GICS_ROADMAP_v1_3_3.md` (este documento)
- `docs/PRODUCTION_PLAN_V1_3_3.md`
- Actualización de referencias en `README.md` y `docs/VERSIONING.md`

---

## Criterio de “listo para implementar”

Se considera listo cuando:

- Existe rama `dev/v1.3.3` activa y usable.
- La política de deprecación documental está explícita y versionada.
- Los documentos de arranque 1.3.3 existen y son referenciables desde versionado.

---

## Siguientes pasos (fase implementación)

1. Definir objetivos técnicos concretos de 1.3.3 (feature set / hardening / performance).
2. Establecer plan por fases con gates de verificación (`build`, `test`, `verify`, `bench` si aplica).
3. Ejecutar ciclo normal de commits/PR sobre `dev/v1.3.3`.
