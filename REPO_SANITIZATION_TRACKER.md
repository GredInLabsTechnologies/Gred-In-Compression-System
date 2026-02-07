# GICS Repository Sanitization Tracker

> **Objetivo**: Convertir este repo en un CORE limpio (producto GICS) y externalizar todo lo histórico a `gics-archive`.

---

## 🎯 Resumen Ejecutivo

| Concepto | Descripción |
|----------|-------------|
| **CORE** | Repo de producto. Solo código vivo + docs vivas + tooling vivo. |
| **ARCHIVE** | Repo museo (append-only). Contiene v1.1 frozen, v1.2 canonical/distribution/deploy. |

---

## 📊 Progress Overview

| Fase | Descripción | Estado | Criterios |
|:----:|-------------|:------:|-----------|
| 1 | Freeze State & Branching | ✅ | Branch + Tag creados |
| 2 | Crear `gics-archive` | ⚪ | Repo inicializado con estructura |
| 3 | Checksums en Archive | ⚪ | SHA256SUMS.txt generado |
| 4 | Punteros en CORE | ⚪ | ARCHIVE_POINTERS.md + VERSIONING.md |
| 5 | Podar CORE | ⚪ | Directorios legacy eliminados |
| 6 | Sanitizar Tests | ⚪ | Solo Vitest válido en tests/ |
| 7 | Sanitizar Docs | ⚪ | README neutral + docs actualizadas |
| 8 | Scripts Oficiales | ⚪ | build/test/bench/verify funcionando |
| 9 | Validación Final | ⚪ | npm ci/build/test/bench OK |

**Leyenda**: ⚪ Not Started | 🟡 In Progress | ✅ Complete | ❌ Blocked

---

## 📋 FASE 1: Freeze State & Branching ✅

**Goal**: Baseline estable antes de limpieza destructiva.

### Checklist
- [x] Crear rama `repo-sanitize`
- [x] Crear tag `archive-snapshot-2026-02-07`
- [x] Verificar `git status` limpio

### Entregables
- Rama `repo-sanitize` activa ✅
- Tag para rollback ✅

### Criterios de Aceptación
- `git branch` muestra `repo-sanitize` ✅
- `git tag` incluye `archive-snapshot-*` ✅

---

## 📋 FASE 2: Crear Repo `gics-archive`

**Goal**: Inicializar repo hermano con estructura correcta.

### Checklist
- [ ] Crear carpeta `../gics-archive/`
- [ ] `git init`
- [ ] Crear README.md, INDEX.md, POLICY_NO_TOUCH.md
- [ ] Crear estructura de directorios:
  ```
  versions/v1.1/frozen/
  versions/v1.1/docs/
  versions/v1.1/verification/
  versions/v1.1/manifests/
  versions/v1.2/canonical/
  versions/v1.2/distribution/
  versions/v1.2/deploy/
  versions/v1.2/docs/
  versions/v1.2/verification/
  versions/v1.2/manifests/
  benchmarks/postfreeze/
  benchmarks/harnesses/
  checksums/
  ```
- [ ] Copiar contenido del CORE a destinos:

| Origen (CORE) | Destino (ARCHIVE) |
|---------------|-------------------|
| `gics_frozen/v1_1_0/` | `versions/v1.1/frozen/` |
| `gics_frozen/v1_2_canonical/` | `versions/v1.2/canonical/` |
| `gics-v1.2-distribution/` | `versions/v1.2/distribution/` |
| `deploy/gics-v1.2/` | `versions/v1.2/deploy/` |
| `bench_postfreeze_artifacts/` | `benchmarks/postfreeze/` |
| `bench_postfreeze_summary_gen.ts` | `benchmarks/harnesses/` |
| `bench_postfreeze_verifier.ts` | `benchmarks/harnesses/` |
| `empirical-compare.mjs` | `benchmarks/harnesses/` |

- [ ] Commit inicial: `archive: initial import from <core commit hash>`

### Entregables
- Repo `gics-archive` con estructura completa
- Contenido copiado sin modificar

### Criterios de Aceptación
- `ls ../gics-archive/versions/` muestra v1.1 y v1.2
- Archivos copiados byte-identical

---

## 📋 FASE 3: Checksums en Archive

**Goal**: Integridad verificable de todo contenido importado.

### Checklist
- [ ] Generar `checksums/SHA256SUMS.txt` recursivo
- [ ] Commit: `archive: add checksums`

### Script sugerido (PowerShell)
```powershell
Get-ChildItem -Recurse -File | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    "$hash  $($_.FullName -replace [regex]::Escape((Get-Location).Path + '\'), '')"
} | Out-File checksums/SHA256SUMS.txt -Encoding UTF8
```

### Entregables
- `checksums/SHA256SUMS.txt` con todas las entradas

### Criterios de Aceptación
- Cada archivo en archive tiene entrada en SHA256SUMS.txt

---

## 📋 FASE 4: Punteros en CORE

**Goal**: Documentar referencias al archive para trazabilidad.

### Checklist
- [ ] Crear `docs/ARCHIVE_POINTERS.md`:
  - URL del archive
  - Commit hash del archive
  - Lista de rutas clave + checksums
- [ ] Crear/actualizar `docs/VERSIONING.md`:
  - v1.1 → archive/versions/v1.1
  - v1.2 → archive/versions/v1.2
  - v1.3 → se implementará en core

### Entregables
- `docs/ARCHIVE_POINTERS.md`
- `docs/VERSIONING.md`

### Criterios de Aceptación
- Punteros contienen hashes verificables

---

## 📋 FASE 5: Podar CORE

**Goal**: Eliminar todo contenido ya archivado.

### Checklist - Directorios a ELIMINAR
- [ ] `gics_frozen/`
- [ ] `gics-v1.2-distribution/`
- [ ] `deploy/gics-v1.2/`
- [ ] `bench_postfreeze_artifacts/`

### Checklist - Archivos raíz a ELIMINAR
- [ ] `bench_postfreeze_summary_gen.ts`
- [ ] `bench_postfreeze_verifier.ts`
- [ ] `empirical-compare.mjs`
- [ ] `GICS_v1.2_CRITICAL_CONTRACT.md`
- [ ] `GICS_v1.2_TECHNICAL_DOSSIER.md`
- [ ] `HANDOVER_GICS_v1.2.md`
- [ ] `RESUMEN_EJECUTIVO.txt`
- [ ] `DISTRIBUTION_MANIFEST.md`
- [ ] `EMPAQUETADO.md`
- [ ] `PACKAGE_VERIFICATION.md`
- [ ] `INSTALL.md` (si es v1.2 específico)
- [ ] Todos los `.zip`, `.tgz`, `.log`, `.txt` de pruebas legacy

### Entregables
- CORE sin directorios/archivos legacy

### Criterios de Aceptación
- `ls` no muestra ningún directorio listado arriba
- Root limpio con solo: src/, tests/, bench/, tools/, docs/, README.md, package.json, tsconfig.json, vitest.config.ts

---

## 📋 FASE 6: Sanitizar Tests (Vitest)

**Goal**: `tests/` solo contiene suites Vitest válidas.

### Checklist
- [ ] Identificar archivos que NO son tests Vitest
- [ ] Mover scripts autoejecutables a `tools/verify/`
- [ ] Ajustar `vitest.config.ts` con include explícito
- [ ] Corregir imports rotos o excluir tests legacy

### Entregables
- `tests/` con solo `.test.ts` válidos
- `tools/verify/` con scripts standalone

### Criterios de Aceptación
- `npm run test` pasa sin errores
- No hay archivos ejecutables sueltos en tests/

---

## 📋 FASE 7: Sanitizar Documentación

**Goal**: Docs neutrales y actualizadas.

### Checklist
- [ ] `README.md`: lenguaje neutral (sin WoW, sin Gred In Labs)
- [ ] Crear/actualizar `docs/SECURITY_MODEL.md`
- [ ] Crear/actualizar `docs/FORMAT.md`
- [ ] Crear/actualizar `docs/REPO_LAYOUT.md`

### Entregables
- README profesional
- Docs técnicas completas

### Criterios de Aceptación
- Grep "WoW\|Gred In Labs" = 0 resultados en docs vivas

---

## 📋 FASE 8: Scripts Oficiales

**Goal**: package.json con comandos estandarizados.

### Scripts requeridos
```json
{
  "build": "tsc",
  "test": "vitest run",
  "bench": "<runner estable>",
  "verify": "<script rápido en tools>"
}
```

### Checklist
- [ ] Verificar/crear script `build`
- [ ] Verificar/crear script `test`
- [ ] Verificar/crear script `bench`
- [ ] Verificar/crear script `verify`

### Entregables
- package.json con 4 scripts funcionando

### Criterios de Aceptación
- Cada script ejecuta sin error

---

## 📋 FASE 9: Validación Final

**Goal**: Confirmar que todo funciona.

### Checklist
- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `npm run test`
- [ ] `npm run bench`
- [ ] Commit: `chore(repo): sanitize core + externalize archive`

### Entregables
- CORE funcional y limpio
- Commit final de sanitización

### Criterios de Aceptación
- Los 4 comandos ejecutan sin errores
- Estructura de directorios coincide con objetivo

---

## 🏗️ Estructura Objetivo CORE (post-cleanup)

```
/
├── src/
├── tests/                 (solo Vitest)
├── bench/                 (bench vivo)
├── tools/
│   └── verify/
├── docs/
│   ├── ARCHIVE_POINTERS.md
│   ├── VERSIONING.md
│   ├── SECURITY_MODEL.md
│   ├── FORMAT.md
│   └── REPO_LAYOUT.md
├── GICS_v1.3_IMPLEMENTATION_REPORT.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## 🏗️ Estructura Objetivo ARCHIVE

```
/
├── README.md
├── INDEX.md
├── POLICY_NO_TOUCH.md
├── versions/
│   ├── v1.1/
│   │   ├── frozen/
│   │   ├── docs/
│   │   ├── verification/
│   │   └── manifests/
│   └── v1.2/
│       ├── canonical/
│       ├── distribution/
│       ├── deploy/
│       ├── docs/
│       ├── verification/
│       └── manifests/
├── benchmarks/
│   ├── postfreeze/
│   └── harnesses/
└── checksums/
    └── SHA256SUMS.txt
```

---

## ⚠️ Reglas Anti-Regresión

1. **ARCHIVE es append-only** — nunca editar contenido importado
2. **CORE nunca re-incluye** — `gics_frozen/`, `gics-v1.2-distribution/`, `deploy/` antiguos
3. **Toda reubicación** — se documenta en INDEX.md y se recalculan checksums

---

## 📜 Historical Log

| Fecha | Agente | Fase | Acción | Comentarios |
|-------|--------|------|--------|-------------|
| 2026-02-07 | Antigravity | - | Inicialización | Creado tracker completo con 9 fases |
| 2026-02-07 | Antigravity | 1 | ✅ Completada | Rama `repo-sanitize`, tag `archive-snapshot-2026-02-07`, working tree clean |
