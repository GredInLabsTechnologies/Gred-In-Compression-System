# GICS v1.3 — Informe de Implementación (Propuesta)

**Estado:** propuesta de diseño (sin implementación)

**Objetivo del documento**
1) Dejar por escrito (en el repo) el plan de cambios para GICS **v1.3**.
2) Definir una **lista de archivos/directorios que NO se deben tocar bajo ninguna circunstancia** para que la implementación de v1.3 sea reproducible y auditable.
3) Explicar el porqué de las métricas observadas v1.1 vs v1.2 y cómo cerrar el gap de ratio sin romper la filosofía del sistema.

> Nota: Este informe asume la filosofía acordada: **en dominio objetivo** se persigue ≥100×; **bajo ataque** CHM deriva a cuarentena/fail‑safe (integridad + auditoría), no “100× literal” sobre entropía máxima.

---

## 1) Hallazgos empíricos: v1.1 vs v1.2 (resumen)

En pruebas empíricas locales, el patrón observado fue:

- **v1.1 (HybridWriter/HybridReader)**
  - Ratio/bytes: **muy superior** en datasets estructurados.
  - Coste CPU: mayor.
- **v1.2 (GICSv2Encoder/GICSv2Decoder)**
  - Velocidad: **muy superior** (encode/decode rápidos).
  - Ratio/bytes: inferior.

### Causa raíz del gap de ratio
v1.1, además de su modelado interno, aplica un **backend entropía** (Brotli por defecto, o Zstd opcional) que “exprime” la redundancia residual.
v1.2 usa codecs ligeros (varint/delta/DoD/RLE/bitpack/dict), pero **no tiene una etapa entropía final** equivalente. Eso explica por qué v1.2 es rápido pero produce más bytes.

---

## 2) Objetivos v1.3 (definición)

### 2.1 Objetivos funcionales
1) **Multi‑item estricto (sin fallback legacy):**
   - v1.3 **no** debe decodificar archivos “single‑item legacy”.
   - Si faltan streams obligatorios o su coherencia falla → **fail‑closed**.

2) **Agnóstico a variantes/dominio:**
   - El conjunto de items puede variar por snapshot.
   - No se asumen reglas de WoW/MMO/Wall‑Street (solo estructura genérica de series históricas con items).

3) **Fail‑safe bajo ataque (CHM):**
   - Detección de anomalía/regime shift → **QUARANTINE**.
   - Quarantine no contamina contexto (snapshot/restore) y es auditable.

### 2.2 Objetivos de calidad
1) **Ratio:** acercar o superar v1.1 en dominio objetivo usando backend entropía (por simplicidad: **Zstd**).
2) **Determinismo:** mismo input lógico → mismos bytes.
3) **Robustez:** límites, validaciones, fail‑closed (EOS, longitudes, streams faltantes, etc.).

---

## 3) Decisiones de diseño v1.3

### 3.1 Dos capas de codec: INNER + OUTER
Para poder cambiar backend rápidamente (Zstd/Brotli/propietario/otros) sin reescribir la lógica:

- **INNER codec**: el codec actual por stream (delta/DoD/bitpack/RLE/dict/varint…).
- **OUTER codec**: wrapper que comprime el resultado del INNER.

Esto permite:
- iterar en backends (Zstd hoy, propio mañana) tocando 2–3 puntos,
- mantener la semántica y telemetría del *front‑end* GICS,
- mantener CHM y quarantine como control de salud.

### 3.2 Semántica del campo `codecId` del header de bloque
En v1.3, el `codecId` del header del bloque pasa a significar **OuterCodecId**.
El `innerCodecId` se incluye dentro del payload.

---

## 4) Especificación propuesta de bloque (v1.3)

### 4.1 Header de bloque
Se mantiene el layout de header del bloque (tamaño constante), pero se cambia la semántica:

- `streamId`: TIME / SNAPSHOT_LEN / ITEM_ID / VALUE / QUANTITY
- `codecId`: **outerCodecId**
- `nItems`: número de items representados en este payload
- `payloadLen`: bytes
- `flags`: health/quarantine tags

### 4.2 Payload v1.3
Formato canónico propuesto:

```text
payload := [innerCodecId: u8] + outerBody

outerBody :=
  if outerCodecId == OUTER_NONE:
      innerPayload
  else:
      outer.compress(innerPayload)
```

### 4.3 Outer codecs (mínimo viable)
- `OUTER_NONE` (identidad)
- `OUTER_ZSTD`

Preparados para futuro sin dolor:
- `OUTER_BROTLI`
- `OUTER_PROPRIETARY_1`

---

## 5) v1.3 es estrictamente multi‑item (sin legacy)

### 5.1 Streams obligatorios
En v1.3 un archivo válido debe contener (en alguna forma coherente):

- TIME
- SNAPSHOT_LEN
- ITEM_ID
- VALUE
- QUANTITY

Si falta `SNAPSHOT_LEN` o si la coherencia entre streams no cuadra → **error**.

### 5.2 Validaciones mínimas de coherencia (decoder)
- `timeData.length === snapshotLengths.length`
- `sum(snapshotLengths) === itemIds.length`
- `itemIds.length === priceData.length`
- `priceData.length === quantityData.length` (si QUANTITY es obligatorio)

### 5.3 Política explícita decidida
**No se deben leer archivos viejos single‑item.**

---

## 6) Registro de outer codecs (pluggable)

### 6.1 Archivo único de registro
Crear un módulo tipo:

`src/gics/v1_2/outer-codecs.ts` (ruta sugerida; puede ubicarse en `src/gics/v1_3/` si se crea ese árbol)

Interfaz sugerida:

```ts
export interface OuterCodec {
  id: number;
  name: string;
  compress(data: Uint8Array, level?: number): Promise<Uint8Array>;
  decompress(data: Uint8Array): Promise<Uint8Array>;
}
```

Y un registry:

```ts
export const OUTER_CODECS: Record<number, OuterCodec> = { ... };
export function getOuterCodec(id: number): OuterCodec { ... }
```

### 6.2 Configuración para A/B rápido
- `GICS_OUTER_CODEC=none|zstd|brotli|proprietary1`
- `GICS_OUTER_LEVEL=<int>`

---

## 7) CHM/quarantine con OUTER (política)

### 7.1 Qué debe medir CHM
Recomendación: que CHM use el tamaño **final** (outer incluido) para mantener la correlación con los bytes reales almacenados.

### 7.2 Quarantine y auditoría
Recomendación operacional:
- **En QUARANTINE, forzar OUTER_NONE** (facilita inspección humana y herramientas forenses).
- Registrar telemetría suficiente para reproducir el evento.

---

## 8) Mapa de cambios en código (sin implementar aquí)

### 8.1 Archivos a modificar para v1.3 (cuando se implemente)
1) `src/gics/v1_2/format.ts`
   - introducir `OuterCodecId`
   - ajustar la semántica del `codecId` del header

2) `src/gics/v1_2/encode.ts`
   - envolver payload con OUTER
   - escribir `innerCodecId` dentro del payload
   - garantizar emisión de streams multi-item SIEMPRE

3) `src/gics/v1_2/decode.ts`
   - eliminar fallback single-item
   - outer-decompress + inner-decode
   - validaciones de coherencia

4) `src/gics/v1_2/outer-codecs.ts` (nuevo)
   - registry + implementación Zstd

5) Bench/tests
   - actualizar/añadir pruebas de “strict multi‑item”
   - benchmarks A/B: v1.1 vs v1.3(outer=zstd)

---

## 9) Contrato de preservación: archivos/directorios NO TOCAR

La implementación de v1.3 debe poder compararse contra referencias congeladas (v1.1 y v1.2 canonical). Para ello, **estos artefactos no deben modificarse, borrarse ni “arreglarse”**.

### 9.1 REGLA ABSOLUTA
**NO** modificar el contenido de los ficheros listados aquí.

Se permite:
- **reubicar** (mover de carpeta) *solo* si:
  1) NO se altera el contenido,
  2) se deja un rastro explícito en este documento (sección 9.3 “Tabla de reubicaciones”).

No se permite:
- borrar,
- reescribir,
- re-formatear,
- “limpiar imports”,
- renombrar símbolos,
- cambiar tests/harness dentro de estos directorios.

### 9.2 Lista “NO TOCAR” (puntos de verdad / golden references)

#### A) Referencia v1.1 (congelada)
- `gics_frozen/v1_1_0/**`
  - Motivo: implementación inmutable de v1.1 (golden reference para regresión).

#### B) Referencia v1.2 canonical (congelada)
- `gics_frozen/v1_2_canonical/**`
  - Motivo: baseline canonical de v1.2 para comparación de formato/codec.

#### C) Distribución/paquete firmado (artefactos de entrega)
- `gics-v1.2-distribution/**`
- `deploy/gics-v1.2/**`
  - Motivo: paquetes de distribución, guías, y material contractual.

#### D) Pruebas/herramientas de verificación contractual
- `verify_gics_v1.2.ts`
- `PACKAGE_VERIFICATION.md`
- `DISTRIBUTION_MANIFEST.md`
- `GICS_v1.2_CRITICAL_CONTRACT.md`
- `GICS_v1.2_TECHNICAL_DOSSIER.md`
- `HANDOVER_GICS_v1.2.md`
- `golden_hashes.txt`
  - Motivo: pruebas/contratos/artefactos para reproducibilidad y auditoría.

#### E) Bench suite (para comparativas longitudinales)
- `bench/**`
- `bench_postfreeze_artifacts/**`
- `bench_postfreeze_summary_gen.ts`
- `bench_postfreeze_verifier.ts`
  - Motivo: histórico de resultados y harnesses de medición.

#### F) El comparador empírico añadido
- `empirical-compare.mjs`
  - Motivo: harness empírico reproducible v1.1 vs v1.2. (Si se sustituye, debe mantenerse este como referencia o archivarse con hash.)

> Nota: si se decide mover cualquiera de estos, debe registrarse abajo.

### 9.3 Tabla de reubicaciones (obligatoria si se mueve algo)
Si algún artefacto de la lista “NO TOCAR” se reubica, añadir una fila aquí:

| Artefacto | Ruta original | Ruta nueva | Commit/fecha | Motivo | Hash SHA256 del fichero/directorio |
|---|---|---|---|---|---|
| (pendiente) |  |  |  |  |  |

---

## 10) Limpieza previa (recomendada) — sin romper referencias

Antes de implementar v1.3 se recomienda una limpieza, **pero respetando 9.x**:

1) Separar claramente “core actual” vs “frozen canonical”.
2) Aislar tests que hoy no son suites Vitest (evitar ruido en `npm test`).
3) Consolidar documentación duplicada (sin tocar distribución congelada; crear docs nuevos si hace falta).

---

## 11) Criterios de aceptación (DoD) para v1.3

1) **Strict multi-item**
   - No existe fallback single-item.
   - Falla si faltan streams obligatorios.

2) **Outer wrapper pluggable**
   - OUTER_NONE y OUTER_ZSTD funcionan.
   - Cambiar backend requiere tocar el registry y (como mucho) 1–2 configs.

3) **CHM/quarantine**
   - Entrada adversarial → quarantine → no crash, no contaminación de contexto.

4) **Medición**
   - Bench: v1.3(outer=zstd) mejora ratio vs v1.2 y se acerca/supera v1.1 en dominio objetivo.

---

## 12) Apéndice: por qué Zstd primero

Se elige Zstd por simplicidad y buen balance ratio/velocidad. Además, el wrapper pluggable permite migrar a:
- Brotli,
- backend propietario,
- otra implementación Zstd (nativa) en el futuro,
sin modificar el modelo GICS.
