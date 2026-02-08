# GICS v1.3 — Production Plan (Definitivo)

> Propósito: este documento es un **runbook** para que agentes futuros puedan implementar GICS v1.3 por fases, **verificar** cada fase con comandos reproducibles, y **anotar** si fue exitoso, qué se mejoró y observaciones útiles.
>

**Operativa / ejecución por agentes:** ver **`docs/AGENT_PROTOCOL_V1_3.md`** (SOP del comando `/v1.3 fase N`, gates de verificación, revisión, commit/push).
> Estado: **Plan aprobado** (pendiente de implementación).

**Operativa / ejecución por agentes:** ver **`docs/AGENT_PROTOCOL_V1_3.md`** (SOP del comando `/v1.3 fase N`, gates de verificación, revisión, commit/push).

---

## 1) Contexto (por qué v1.3)

GICS v1.2 logra ~23× en series temporales con tendencia, pero **~37% del output es overhead de cabeceras por bloque** (≈3200 bloques × 11 bytes). Añadir Zstd **por bloque** empeora: cada bloque pequeño introduce cabeceras/frame overhead adicionales.

La arquitectura correcta es **compresión outer a nivel de stream**:

- Agrupar todos los payloads de un mismo stream.
- Concatenarlos.
- Aplicar **una sola** compresión outer (Zstd) por stream.
- Mantener metadata por bloque en un **manifest** (sin “payloadLen” por bloque en el wire format).

Proyección: **110–150×** en datos “trending”.

---

## 2) Decisiones cerradas (requisitos obligatorios)

- **Segmentos**: auto-seal por tamaño (**~1MB sin comprimir**, configurable).
  - Un segmento es la unidad de **inmutabilidad** y **append**.
- **Granularidad de consulta (query)**: **segment-level**.
  - Para query: descartar segmentos con index → descomprimir el segmento seleccionado → filtrar en memoria.
- **I/O**: soportar **in-memory** (Uint8Array) **y FileHandle** (append en disco) desde el inicio.
- **Index por segmento**: implementar **Bloom filter + sorted array** de itemIds.

---

## 3) Invariantes / reglas de ingeniería

1. **Fail-closed** ante datos truncados/corruptos:
   - Truncación → `IncompleteDataError`.
   - Corrupción / hash mismatch / CRC mismatch → `IntegrityError`.
2. **Sin estado global mutable** entre instancias.
3. **Sin** `process.env` (todo vía `options`).
4. **Sin** `console.log` en `src/`.
5. **Sin** `import * as fs` en código de librería.
6. Determinismo: mismo input lógico + misma config → mismos bytes.

---

## 4) Formato v1.3 (visión global)

### 4.1 Estructura a nivel de archivo (con segmentación)

```
[FileHeader]
  [Segment 0]
  [Segment 1]
  ...
[FileEOS]
```

### 4.2 Estructura de un Segment

```
[SegmentHeader]
[StreamSection: TIME]
[StreamSection: SNAPSHOT_LEN]
[StreamSection: ITEM_ID]
[StreamSection: VALUE]
[StreamSection: QUANTITY]
[SegmentFooter]
```

### 4.3 FileHeader (base)

```
magic(4:"GICS") + version(1:0x03) + flags(4) + streamCount(1) + reserved(4)
```

Si `encryption flag`:

```
encMode(1) + salt(16) + authVerify(32) + kdfId(1) + iterations(4) + digestId(1) + fileNonce(8)
```

### 4.4 StreamSection

```
streamId(1) + outerCodecId(1) + blockCount(2) + uncompressedLen(4) + compressedLen(4)
+ sectionHash(32)
+ [BlockManifest: (innerCodecId(1) + nItems(4) + flags(1)) × blockCount]
+ compressedPayload  // outerCodec(concat(innerPayloads))
```

**Hash chain**:

- `genesis = SHA-256(fileHeaderBytes || segmentHeaderBytes)` (recomendado)
- `sectionHash = SHA-256(prevHash || streamId || blockCount || manifest || compressedPayload)`

### 4.5 EOS / Footers

- `SegmentFooter`: incluye `segmentRootHash` (último hash de secciones) + CRC32 del segmento.
- `FileEOS`: incluye `fileRootHash` (cadena de segmentos o hash total) + CRC32 del archivo.

---

## 5) Streams y categorías

### 5.1 Streams obligatorios

- TIME
- SNAPSHOT_LEN
- ITEM_ID
- VALUE
- QUANTITY

**El decoder v1.3 debe ser estricto**: si falta un stream, error.

### 5.2 Categorías

**CHM-routed streams**: TIME, VALUE
- Split por bloques (BLOCK_SIZE)
- CHM routing CORE/QUARANTINE
- Flags por bloque (manifest)

**Structural streams**: SNAPSHOT_LEN, ITEM_ID, QUANTITY
- Payload único
- `blockCount = 1`
- Trial-based selection de inner codecs por stream

---

## 6) Índice por segmento (Bloom + Sorted)

### 6.1 Objetivo
Permitir:
- saltar segmentos que no contienen un itemId,
- minimizar descompresión durante queries,
- mantener determinismo.

### 6.2 Contenido mínimo por segmento

- `bloomFilter`: bitset fijo (p.ej. 2048–8192 bits) con `k` hashes deterministas.
- `sortedItemIds`: array ordenado de itemIds presentes (serializado varint + delta).

### 6.3 Algoritmo de query (segment-level)

1) Revisar `bloomFilter`. Si “definitivamente no”: skip.
2) Si Bloom dice “quizás”, confirmar por `sortedItemIds` (binary search).
3) Solo entonces descomprimir el segmento y filtrar en memoria.

---

## 7) API pública objetivo

```ts
// Core
const bytes = await GICS.pack(snapshots, options?);
const snapshots = await GICS.unpack(bytes, options?);
const report = await GICS.verify(bytes); // sin descompresión

// Streaming (append workflow)
const encoder = new GICS.Encoder(options?);
encoder.push(snapshot);
const bytes = await encoder.seal();

const decoder = new GICS.Decoder(bytes, options?);
const snapshots = await decoder.readAll();
```

Y para disco:

```ts
const enc = await GICS.Encoder.openFile(fileHandle, options);
enc.push(snapshot);
await enc.sealToFile();
```

---

## 8) Plan por fases (committeable + verificable)

> Cada fase debe cerrar con verificación: `npm run build` + `npm test`.

### Tabla de tracking (rellenar por el agente)

| Fase | Objetivo | Estado | PR/Commit | Owner | Fecha | Notas |
|---|---|---|---|---|---|---|
| 1 | Foundation / hygiene | ✅ |  |  | 2026-02-08 | Gates OK: `npm run build` + `npm test` (131 passed, 2 skipped). Fixes de determinismo/robustez en v1.2 + CHM. |
| 2 | Bug fixes (130/130) | ⬜ |  |  |  |  |
| 3 | Formato v1.3 (stream sections + outer + chain) | ⬜ |  |  |  |  |
| 3.1 | Segmentación + index + append FileHandle | ⬜ |  |  |  |  |
| 4 | Trial-based codec (todos los streams) | ⬜ |  |  |  |  |
| 5 | AES-256-GCM per section | ⬜ |  |  |  |  |
| 6 | Validación cruzada + forensics verify() | ⬜ |  |  |  |  |
| 7 | API polish | ⬜ |  |  |  |  |
| 8 | Adversarial suite | ⬜ |  |  |  |  |

Leyenda de Estado: ⬜ pendiente / 🟨 en progreso / ✅ completada / ❌ bloqueada

---

### Fase 1 — Foundation (restructure + hygiene)

Objetivo: limpieza con **cero cambio de comportamiento**.

Checklist:
- [ ] Flatten `src/gics/v1_2/` → `src/gics/` y actualizar imports.
- [ ] Archivar/aislar legado (ver `docs/ARCHIVE_POINTERS.md`).
- [ ] Limpiar `gics-types.ts` (eliminar tipos v1.1-only).
- [ ] Eliminar `fs`, `process.env`, `console.log`, `static` mutable.
- [ ] Reemplazar `any` por tipos.

Estado (2026-02-08):
- ✅ Tests verdes (`npm test`: 131 passed, 2 skipped)
- ✅ Build OK (`npm run build`)

Notas del agente:
- Decoder v1.2 ahora es **fail-closed** en truncación/EOS (`IncompleteDataError`) y evita estado estático compartido.
- Encoder v1.2: se corrigió la incoherencia TIME BitPack (debe bitpackear **Delta-of-Delta** para ser consistente con el decoder).
- CHM: recovery ahora respeta `PROBE_INTERVAL` (solo cuenta probes) y se separó por stream (TIME/VALUE) para evitar recuperación doble por interleaving.
- Tests CHM: el parser de bloques ahora para correctamente en el byte EOS (`0xFF`) para evitar `RangeError`.

Verificación:
```bash
npm run build
npm test
```

Salida esperada:
- Tests pasan (objetivo intermedio: ~125/130 según plan original).

---

### Fase 2 — Bug fixes (130/130)

Checklist:
- [ ] `eos_missing`: lanzar `IncompleteDataError`.
- [ ] `integrity_mismatch`: asegurar roundtrip bit-exact (eliminar redondeos/pérdidas).
- [ ] Bounds checking: no `RangeError` al parsear headers/payloads malformados.
- [ ] Fix CHM: reset correcto en recovery (edge-case).

Verificación:
```bash
npm test
```

Salida esperada:
- **130/130**.

---

### Fase 3 — Nuevo formato v1.3 (StreamSections + Outer Zstd + Hash chain)

Nuevos archivos (mínimo):
- `src/gics/outer-codecs.ts`
- `src/gics/stream-section.ts`
- `src/gics/integrity.ts`

Checklist:
- [ ] `format.ts`: `GICS_VERSION_BYTE=0x03`, `OuterCodecId`, `InnerCodecId`, nuevo EOS.
- [ ] `encode.ts`: inner → agrupar por stream → manifest → outer compress → hash chain → escribir.
- [ ] `decode.ts`: parse v1.3 → verify chain → outer decompress → split → inner decode.
- [ ] Modo `strict` (default) vs `warn` ante hash mismatch.
- [ ] Eliminar fallback legacy single-item.

Tests nuevos mínimos:
- [ ] Tamper test: modificar 1 byte en una section → `IntegrityError`.
- [ ] Version mismatch: v1.2 en decoder v1.3 → error limpio.

Verificación:
```bash
npm run build
npm test
```

---

### Fase 3.1 — Segmentación + Index + Append (FileHandle)

Checklist:
- [ ] Definir `SegmentHeader/SegmentFooter/FileEOS`.
- [ ] `SegmentBuilder`: auto-seal por tamaño (~1MB uncompressed).
- [ ] `SegmentIndex`: bloom + sorted array.
- [ ] Decoder: iterar segmentos; query descarta con index; descomprime solo segmentos necesarios.
- [ ] Implementar append en disco (leer tail, localizar EOS, truncar, escribir segmento, escribir nuevo EOS).

Tests mínimos:
- [ ] Append 2 segmentos → decode = concatenación.
- [ ] Query item exclusivo del segmento 2 → solo descomprime segmento 2 (instrumentación / mock).
- [ ] Bloom false positive → sorted array evita descompresión.

---

### Fase 4 — Trial-based codec selection (todos los streams)

Checklist:
- [ ] TIME y VALUE: por bloque, probar top 2–3 inner codecs y elegir mínimo.
- [ ] SNAPSHOT_LEN: probar VARINT/RLE/BITPACK.
- [ ] ITEM_ID: probar VARINT/DICT/BITPACK.
- [ ] QUANTITY: probar VARINT/RLE/DICT.

Verificación:
- [ ] `npm run bench` mejora ratio vs baseline.

---

### Fase 5 — Cifrado AES-256-GCM por StreamSection

Nuevos archivos:
- `src/gics/encryption.ts`

Checklist:
- [ ] PBKDF2 deriveKey(password, salt).
- [ ] Encrypt/decrypt por sección con IV determinista (HMAC(fileNonce||streamId) → 12 bytes).
- [ ] AAD = bytes del FileHeader.
- [ ] Wrong password → error limpio.
- [ ] Tampered ciphertext → `IntegrityError` (GCM auth).

---

### Fase 6 — Validación cruzada + forensics (`GICS.verify`)

Checklist:
- [ ] Cross-stream validation:
  - [ ] `time.length === snapshotLen.length`
  - [ ] `sum(snapshotLen) === itemIds.length`
  - [ ] `itemIds.length === values.length === qty.length`
- [ ] `GICS.verify(bytes)` verifica chain+CRC sin descompresión.

---

### Fase 7 — API polish

Checklist:
- [ ] `src/index.ts` expone solo namespace `GICS` + tipos/errores.
- [ ] Eliminar exports v1.1/legacy del paquete público.

---

### Fase 8 — Adversarial suite

Checklist mínimo (ver DoD):
- [ ] Fuzz roundtrip (≥1000 datasets).
- [ ] Truncation en cada byte → `IncompleteDataError`.
- [ ] Bit-flip → `IntegrityError`.
- [ ] Decompression bomb protections (límites) → `LimitExceededError`.
- [ ] Concurrency 10× paralelo → sin contaminación.

---

## 9) Verificación (comandos oficiales)

```bash
npm run build
npm test
npm run bench
npm run verify
```

---

## 10) Definition of Done (DoD) global

- [ ] `npm run build` sin errores.
- [ ] `npm test` pasa completo.
- [ ] `npm run bench`: TS_TREND_INT ratio **>= 100×**.
- [ ] 0 `any` en `src/`.
- [ ] 0 `console.log` en `src/`.
- [ ] 0 `process.env` en `src/`.
- [ ] Hash chain + CRC detectan corrupción.
- [ ] `GICS.verify()` funciona sin descompresión.
- [ ] Segmentación (~1MB) y append FileHandle funcional.
- [ ] Index Bloom + sorted funcional.
- [ ] Wrong password (si hay cifrado) se rechaza limpiamente.

---

## 11) Plantilla de reporte de implementación (para completar al cerrar fases)

> Copiar/pegar en un PR description o en un archivo `REPORTS/<fecha>_<fase>.md`.

```md
# Reporte de implementación — GICS v1.3

## Resumen
- Fases implementadas:
- Resultado: ✅/❌

## Cambios principales
- (qué y por qué)

## Archivos tocados
- `src/...`
- `tests/...`
- `docs/...`

## Verificación
- `npm run build`: ✅/❌
- `npm test`: ✅/❌ (x/y)
- `npm run bench`: ✅/❌ (ratios)

## Métricas
- Ratio DS-01 (TS_TREND_INT): antes X, después Y
- Encode time: antes X, después Y
- Decode time: antes X, después Y
- Peak RAM: antes X, después Y

## Observaciones / riesgos
- (edge cases)

## Notas adicionales
- (follow-ups recomendados)
```
