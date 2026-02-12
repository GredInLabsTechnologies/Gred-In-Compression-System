# GICS External Audit Planner — CHECKLIST OPERATIVO (Zero-Trust)

> Este documento obliga a cualquier agente a: **verificar lo ya hecho → ejecutar su sección → revalidar → registrar verificables → quedar listo para commit/push**.

## 1) Pre-flight obligatorio (antes de tocar código)
- [ ] Leí este documento completo.
- [ ] Confirmé qué WP me corresponde (uno solo).
- [ ] Verifiqué en sección 9 el estado/evidencias de WPs previos.
- [ ] No hay inconsistencias abiertas en WPs previos.
- [ ] Confirmé invariantes no negociables:
  - [ ] Truncation => `IncompleteDataError`
  - [ ] Corrupción/hash/CRC mismatch => `IntegrityError`
  - [ ] Wrong password/auth => `AuthenticationError`
  - [ ] Fail-closed por defecto
  - [ ] Determinismo (mismo input+config => mismos bytes)
  - [ ] Sin degradar `GICS.verify()` ni hash chain

## 2) Gates y Stop-the-line
### Gates base (siempre)
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run lint`

### Gates condicionales
- [ ] `npm run verify` (si se toca integridad/formato/seguridad)
- [ ] `npm run bench` (si se toca selección codec/rendimiento)
- [ ] `npm run bench:forensics`
- [ ] `npm run bench:forensics:verify`

### Behavioral Trace Equivalence (si aplica)
- [ ] `npm run trace:decode`
- [ ] `npm run trace:encode`
- [ ] `npm run trace:chm`
- [ ] `npm run trace:daemon`

### Stop-the-line
- [ ] Falla build/test/verify (cuando aplique) => STOP
- [ ] Cambio de comportamiento no esperado => STOP
- [ ] Blast radius fuera del plan => STOP

## 3) Orden de ejecución obligatorio
1. [ ] WP-01 Decoder split + trace cursor/offset
2. [ ] WP-02 Insight split (quick win)
3. [ ] WP-03 Encoder split + freeze decisiones codec
4. [ ] WP-04 CHM freeze + diff rutas
5. [ ] WP-05 Daemon dispatcher + orden side-effects

## 4) WP-01 — Decoder split + trace cursor/offset
**Archivos objetivo**
- `src/gics/decode.ts`
- `src/gics/header-security-parser.ts` (nuevo)
- `src/gics/segment-reader.ts` (nuevo)

**Checklist WP-01**
- [ ] Verifiqué baseline + evidencia de estado inicial.
- [ ] Implementé split sin cambio funcional.
- [ ] Ejecuté: build + test + lint + verify + trace:decode.
- [ ] Diff de traza decode = 0 (salvo campos permitidos).
- [ ] Registré verificables en sección 9.

## 5) WP-02 — Insight split (quick win)
**Archivos objetivo**
- `src/insight/correlation.ts`
- `src/insight/pair-engine.ts` (nuevo)
- `src/insight/seasonality-engine.ts` (nuevo)

**Checklist WP-02**
- [ ] Verifiqué WP-01 COMPLETADO en sección 9.
- [ ] Implementé split sin cambio de fórmulas/thresholds.
- [ ] Ejecuté: build + test + lint.
- [ ] `tests/insight-engine.test.ts` estable.
- [ ] Registré verificables en sección 9.

## 6) WP-03 — Encoder split + freeze decisiones codec
**Archivos objetivo**
- `src/gics/encode.ts`
- `src/gics/section-packager.ts` (nuevo)
- `src/gics/codec-selection.ts` (nuevo)

**Checklist WP-03**
- [ ] Verifiqué WP-01 y WP-02 COMPLETADOS en sección 9.
- [ ] Freeze explícito de orden de candidatos.
- [ ] Sin cambios en IDs de codec.
- [ ] Ejecuté: build + test + lint + verify + bench + trace:encode.
- [ ] Diff de decisiones intermedias = 0.
- [ ] Registré verificables en sección 9.

## 7) WP-04 — CHM freeze + diff rutas
**Archivos objetivo**
- `src/gics/chm.ts`
- `tests/gics-chm.test.ts`
- `bench/forensics/postfreeze/harness.postfreeze.ts`

**Checklist WP-04**
- [ ] Verifiqué WP-01..WP-03 COMPLETADOS en sección 9.
- [ ] Congelé baseline de rutas CHM.
- [ ] Ejecuté: build + test + lint + bench:forensics + bench:forensics:verify + trace:chm.
- [ ] Diff rutas CHM = 0.
- [ ] Registré verificables en sección 9.

## 8) WP-05 — Daemon dispatcher + orden side-effects
**Archivos objetivo**
- `src/daemon/server.ts`
- `src/daemon/request-dispatcher.ts` (nuevo)
- `src/daemon/request-types.ts` (nuevo)
- `tests/daemon-recovery.test.ts`
- `tests/daemon-wal.test.ts`

**Checklist WP-05**
- [ ] Verifiqué WP-01..WP-04 COMPLETADOS en sección 9.
- [ ] Mantengo orden WAL→MemTable→Eventos→Locks.
- [ ] Ejecuté: build + test + lint + trace:daemon.
- [ ] Tests de orden side-effects verdes.
- [ ] Diff de orden side-effects = 0.
- [ ] Registré verificables en sección 9.

## 9) Registro de ejecución obligatorio (rellenar al cerrar cada WP)
| WP | Estado (PENDING/IN_PROGRESS/COMPLETED/BLOCKED) | Fecha | Autor | Gates ejecutados | Evidencias verificables | Invariantes validados | Observaciones |
|---|---|---|---|---|---|---|---|
| WP-01 | PENDING |  |  |  |  |  |  |
| WP-02 | PENDING |  |  |  |  |  |  |
| WP-03 | PENDING |  |  |  |  |  |  |
| WP-04 | PENDING |  |  |  |  |  |  |
| WP-05 | PENDING |  |  |  |  |  |  |

### Verificables mínimos por WP
- Hash/ID commit local de trabajo
- Salida de gates ejecutados
- Ruta de artefactos de trazas (si aplica)
- Tests críticos ejecutados

## 10) Checklist final “Listo para commit/push”
- [ ] Mi WP está en estado **COMPLETED** en sección 9.
- [ ] Gates obligatorios en verde y registrados.
- [ ] Evidencias verificables registradas.
- [ ] Sin cambios fuera de alcance del WP.
- [ ] Re-analicé mi propio cambio y no detecté drift.
- [ ] Estoy listo para **pedir permiso explícito** de commit/push.

> Regla: no hacer commit/push sin permiso explícito del usuario.
