# GICS v1.3.2 — Roadmap
## "The Cognitive Storage Engine"

> ⚠️ **Deprecation Notice (v1.3.3 prep, 2026-03-15):** This roadmap is kept as historical release documentation for v1.3.2. For new planning and implementation work, use `docs/roadmaps/GICS_ROADMAP_v1_3_3.md`.

**Fecha:** 2026-02-11T12:00:00Z
**Version:** 1.3.2
**Estado:** Implementado (Legacy for new planning)
**Base:** GICS v1.3.1 (estable, Schema Profiles, AES-256-GCM, hash chain)
**Autores:** Equipo GICS + Claude Opus 4.6 (asistencia estratégica y técnica)

---

## Motivación

GICS v1.3.1 es un sistema de compresión, cifrado e integridad excelente para datos temporales. Pero hoy es **pasivo**: almacena lo que le dan y lo devuelve cuando se lo piden.

El problema: cada sistema que consume GICS (GIMO, Gred-In Labs, cualquier app futura) tiene que construir su propia capa de inteligencia sobre los datos. El Trust Engine de GIMO calcula scores. El asesor de WoW detecta items activos. Una app de nutrición busca patrones alimenticios. Todos hacen lo mismo: **infieren patrones de datos temporales**.

GICS ya tiene toda la información necesaria para hacer esas inferencias. Sabe qué items se mueven, cuáles están dormidos, cuáles correlacionan entre sí, cuáles son predecibles y cuáles anómalos. Solo que hoy esa inteligencia es **implícita** (qué tier ocupa un item) en vez de **explícita** (metadata computada y consultable).

### Lo que GICS 1.3.2 propone

Tres evoluciones en una release:

1. **Daemon Mode** — GICS deja de ser solo una librería. Se convierte en un proceso persistente con estado mutable, WAL, y API IPC. Cualquier sistema (Python, Go, lo que sea) puede hablarle.

2. **Tier Engine** — Gestión inteligente de tiers (HOT/WARM/COLD) con promoción/democión automática, compactación, y rotación temporal. GICS decide dónde vive cada dato.

3. **Insight Engine** — La pieza revolucionaria. GICS computa metadata de comportamiento de forma incremental conforme los datos fluyen. No es batch analytics post-hoc — es inteligencia que emerge del propio almacenamiento en tiempo real.

### Qué lo hace diferente de todo lo que existe

| Sistema | Almacena | Comprime | Cifra | Verifica | **Entiende** |
|---------|----------|----------|-------|----------|---------------|
| Redis | si | no | no | no | no |
| InfluxDB | si | si | no | no | query-time |
| RocksDB | si | si | no | no | no |
| SQLite | si | no | si* | no | no |
| **GICS 1.3.2** | **si** | **si** | **si** | **si** | **si (incremental)** |

GICS 1.3.2 sería el primer motor de almacenamiento que **computa inteligencia como efecto secundario del propio almacenamiento**, no como una capa separada.

---

## Arquitectura target

```
Consumidor (Python/Go/cualquiera)
       │
       │  IPC (Unix socket / Named pipe)
       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     GICS DAEMON  v1.3.2                             │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  API LAYER                                                   │    │
│  │  put() get() delete() scan() flush() compact()              │    │
│  │  query() verify() subscribe() getInsight() reportOutcome()  │    │
│  └──────────────────────┬──────────────────────────────────────┘    │
│                          │                                          │
│  ┌───────────────────────┼─────────────────────────────────────┐    │
│  │  INSIGHT ENGINE       │                                      │    │
│  │                       ▼                                      │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │    │
│  │  │ Behavioral  │  │ Correlation  │  │ Predictive        │   │    │
│  │  │ Tracker     │  │ Analyzer     │  │ Signals           │   │    │
│  │  │             │  │              │  │                   │   │    │
│  │  │ - velocity  │  │ - co-move    │  │ - trend forecast  │   │    │
│  │  │ - lifecycle │  │ - clusters   │  │ - anomaly alerts  │   │    │
│  │  │ - entropy   │  │ - lead/lag   │  │ - recommendations │   │    │
│  │  │ - streaks   │  │ - seasonal   │  │ - confidence      │   │    │
│  │  └─────────────┘  └──────────────┘  └───────────────────┘   │    │
│  │                                                              │    │
│  │  ┌───────────────────────────────────────────────────────┐   │    │
│  │  │ Feedback Loop                                         │   │    │
│  │  │ reportOutcome(insightId, result) → ajusta confianza   │   │    │
│  │  └───────────────────────────────────────────────────────┘   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                          │                                          │
│  ┌───────────────────────┼─────────────────────────────────────┐    │
│  │  TIER ENGINE          │                                      │    │
│  │                       ▼                                      │    │
│  │  HOT (MemTable)    WARM (segments)     COLD (archive)        │    │
│  │  ┌────────────┐    ┌───────────────┐   ┌──────────────┐     │    │
│  │  │ HashMap    │    │ .gics files   │   │ .gics files  │     │    │
│  │  │ O(1) r/w   │──→│ compressed    │──→│ + AES-256    │     │    │
│  │  │            │    │ queryable     │   │ verify-only  │     │    │
│  │  └────────────┘    └───────────────┘   └──────────────┘     │    │
│  │       │                                                      │    │
│  │       ▼                                                      │    │
│  │  WAL (crash safety)                                          │    │
│  │  ┌──────────────────────────────────────────────────────┐    │    │
│  │  │ append-only log → replay on startup → truncate       │    │    │
│  │  └──────────────────────────────────────────────────────┘    │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  CORE (unchanged from v1.3.1)                                │    │
│  │  encode/decode | segments | schemas | encryption | integrity │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Roadmap por fases

---

### FASE 1: Daemon Core (semanas 1-2)
**Objetivo:** GICS se convierte en un proceso persistente con estado mutable y API IPC.

#### 1.1 MemTable

**Qué:** HashMap en memoria para operaciones HOT con O(1) de lectura y escritura.

**Entregables:**
- `daemon/memtable.ts`: estructura de datos mutable
  ```
  MemTable {
    schema: SchemaProfile
    records: Map<string, MemRecord>
    size: number           // bytes estimados en memoria
    dirtyCount: number     // records modificados desde último flush
  }

  MemRecord {
    key: string            // dimension_key o item_id
    fields: Record<string, number | string>
    created: number        // timestamp primera inserción
    updated: number        // timestamp última modificación
    accessCount: number    // veces leído (para insight engine)
    dirty: boolean         // pendiente de flush
  }
  ```
- Operaciones: `put(key, fields)`, `get(key)`, `delete(key)`, `scan(prefix?)`
- Size tracking: estimación de bytes para trigger de flush
- Threshold configurable: flush cuando `size > maxMemTableBytes` (default 4MB) o `dirtyCount > maxDirtyRecords` (default 1000)

#### 1.2 WAL (Write-Ahead Log)

**Qué:** Archivo append-only que garantiza durabilidad. Si el proceso muere, el WAL se replaya al arrancar para reconstruir el MemTable.

**Entregables:**
- `daemon/wal.ts`: write-ahead log binario
  ```
  WAL Entry (binary):
    [op: u8]           // 0x01=PUT, 0x02=DELETE
    [keyLen: u16]      // longitud de la key
    [key: bytes]       // dimension_key
    [fieldsLen: u32]   // longitud del payload
    [fields: bytes]    // JSON de fields (simple, no necesita compresión)
    [crc32: u32]       // integridad por entry
  ```
- Operaciones:
  - `append(op, key, fields)` → escribe al final del archivo con fsync
  - `replay()` → lee entries secuencialmente, reconstruye MemTable
  - `truncate()` → vacía el WAL después de un flush exitoso a GICS
- Crash recovery:
  1. On startup: detecta si WAL tiene entries
  2. Si sí: replay todas las entries válidas (skip entries con CRC corrupto)
  3. MemTable queda reconstruido
  4. Si una entry tiene CRC malo: log warning, skip, continuar (fail-forward para el WAL, fail-closed para datos corruptos en segmentos)
- Rotation: WAL se trunca después de cada flush exitoso a segmento GICS

#### 1.3 IPC Server

**Qué:** Servidor que expone la API de GICS daemon via socket local. Protocolo ligero tipo JSON-RPC sobre Unix socket (Linux/Mac) o Named pipe (Windows).

**Entregables:**
- `daemon/server.ts`: servidor IPC
  ```
  Protocolo: JSON-RPC 2.0 sobre stream
  Transport: Unix socket (/tmp/gics.sock) o Named pipe (\\.\pipe\gics)

  Mensajes:
  → { "method": "put", "params": { "key": "...", "fields": {...} }, "id": 1 }
  ← { "result": { "ok": true }, "id": 1 }

  → { "method": "get", "params": { "key": "..." }, "id": 2 }
  ← { "result": { "key": "...", "fields": {...}, "tier": "hot" }, "id": 2 }

  → { "method": "scan", "params": { "prefix": "file_write|" }, "id": 3 }
  ← { "result": { "items": [...] }, "id": 3 }
  ```
- Autenticación: token local en archivo (`.gics_token`), similar al patrón actual de GIMO
- Concurrencia: single-writer por diseño (Node.js event loop), múltiples readers simultáneos
- Health check: `{ "method": "ping" }` → `{ "result": { "uptime": ..., "memtable_size": ..., "segments": ... } }`

#### 1.4 Python Client SDK

**Qué:** Cliente ligero en Python para que GIMO (y cualquier app Python) hable con GICS daemon.

**Entregables:**
- `clients/python/gics_client.py`: cliente síncrono/async
  ```python
  class GICSClient:
      def __init__(self, socket_path="/tmp/gics.sock"):
          ...

      async def put(self, key: str, fields: dict) -> bool:
          ...

      async def get(self, key: str) -> dict | None:
          ...

      async def delete(self, key: str) -> bool:
          ...

      async def scan(self, prefix: str = "") -> list[dict]:
          ...

      async def flush(self) -> dict:
          """Fuerza flush de MemTable a segmento GICS."""
          ...

      async def get_insight(self, key: str) -> dict | None:
          """Obtiene metadata de insight para un item."""
          ...

      async def get_insights(self, type: str = None) -> list[dict]:
          """Lista insights activos, opcionalmente filtrados por tipo."""
          ...

      async def report_outcome(self, insight_id: str, result: str) -> bool:
          """Retroalimenta el Insight Engine con el resultado de una recomendación."""
          ...

      async def subscribe(self, event_types: list[str], callback) -> str:
          """Suscribe a eventos (tier_change, anomaly, recommendation...)."""
          ...

      async def ping(self) -> dict:
          ...
  ```
- Zero dependencias externas (solo stdlib de Python)
- Reconnect automático si el daemon se reinicia
- Connection pooling para uso concurrente desde FastAPI

#### 1.5 File Locking

**Qué:** Garantía de single-writer para los archivos GICS en disco.

**Entregables:**
- `daemon/file-lock.ts`: wrapper sobre `flock` (Linux/Mac) / `LockFileEx` (Windows)
- Lock exclusivo durante flush y compactación
- Lock compartido durante lectura de segmentos
- Timeout configurable (default 5s) con error explícito si no se obtiene

**Resultado Fase 1:** GICS corre como daemon, acepta put/get/delete via IPC, persiste con WAL, y cualquier sistema Python puede consumirlo.

---

### FASE 2: Tier Engine (semanas 3-4)
**Objetivo:** Gestión inteligente de datos entre HOT/WARM/COLD con compactación y rotación.

#### 2.1 Flush: MemTable → WARM

**Qué:** Cuando el MemTable alcanza el threshold, se serializa como un nuevo segmento GICS inmutable.

**Entregables:**
- Trigger automático: `memtable.size > maxBytes` OR `memtable.dirtyCount > maxDirty` OR `timeSinceLastFlush > maxInterval`
- Proceso:
  1. Snapshot del MemTable actual (copy-on-write)
  2. Encode como segmento GICS con el schema activo
  3. Append al archivo WARM activo (o crear nuevo si rotación)
  4. Truncar WAL
  5. Marcar records como `dirty = false`
- Flush forzado via API: `flush()` para shutdown graceful o testing
- Métrica: `flush_duration_ms`, `records_flushed`, `bytes_written`

#### 2.2 Compactación

**Qué:** Merge de segmentos WARM para reducir fragmentación y mejorar query performance.

**Entregables:**
- Estrategia size-tiered:
  - Cuando hay N segmentos WARM del mismo rango de tamaño → merge en uno
  - El merge toma la versión más reciente de cada key (last-writer-wins)
  - Records borrados (tombstones) se eliminan en compactación
- Compactación periódica: configurable (default cada 1h o cada 10 segmentos)
- Compactación no bloquea lecturas (se crea nuevo archivo, luego swap atómico)
- Métrica: `compaction_duration_ms`, `segments_merged`, `records_deduplicated`, `space_reclaimed_bytes`

#### 2.3 Rotación WARM → COLD

**Qué:** Archivado automático de datos históricos con cifrado.

**Entregables:**
- Política configurable:
  ```
  rotation_policy {
    warm_retention: "30d"         // datos en WARM máximo 30 días
    cold_retention: "365d"        // datos en COLD máximo 1 año (0 = infinito)
    cold_encryption: true         // cifrar con AES-256-GCM
    cold_password_source: "env"   // GICS_COLD_KEY env var
  }
  ```
- Proceso de rotación:
  1. Identificar segmentos WARM más antiguos que `warm_retention`
  2. Re-encode con cifrado AES-256-GCM
  3. Mover a directorio COLD (`data/cold/`)
  4. Registrar en metadata index
- Verificación periódica de archivos COLD: `GICS.verify()` sin descomprimir
- Purga de archivos COLD más antiguos que `cold_retention`

#### 2.4 Tier Metadata Index

**Qué:** Índice ligero que trackea qué keys están en qué tier, para routing de queries.

**Entregables:**
- Estructura en memoria:
  ```
  TierIndex {
    hot: Set<string>             // keys en MemTable
    warm: Map<string, WarmRef[]> // key → lista de segmentos que la contienen
    cold: Map<string, ColdRef>   // key → archivo COLD que la contiene
  }

  WarmRef { segmentFile: string, segmentIdx: number }
  ColdRef { archiveFile: string, lastUpdated: number }
  ```
- Se reconstruye al startup leyendo headers de segmentos (Bloom filters)
- Se actualiza incrementalmente en cada put/flush/compact/rotate
- Query routing: `get(key)` busca HOT → WARM → COLD automáticamente

**Resultado Fase 2:** GICS gestiona todo el ciclo de vida de los datos. HOT para acceso rápido, WARM para histórico reciente, COLD para archivo cifrado. Compactación y rotación automáticas.

---

### FASE 3: Insight Engine (semanas 5-8)
**Objetivo:** GICS computa inteligencia de forma incremental conforme los datos fluyen. No es analytics post-hoc — es inteligencia que emerge del almacenamiento.

> **Principio clave:** Cada `put()` tiene coste O(1) adicional para el Insight Engine. No hay batch jobs, no hay queries costosos. La inteligencia se acumula en tiempo real.

#### 3.1 Behavioral Tracker (per-item metadata)

**Qué:** Cada item en GICS acumula metadata de comportamiento computada incrementalmente.

**Entregables:**
- Metadata por item (computada en cada `put()`):
  ```
  ItemBehavior {
    key: string

    // --- Actividad ---
    velocity: number           // tasa de cambios por ventana temporal (EMA)
    accessFrequency: number    // lecturas por ventana temporal
    lastWrite: number          // timestamp último put()
    lastRead: number           // timestamp último get()
    writeCount: number         // total de escrituras históricas
    readCount: number          // total de lecturas históricas

    // --- Estabilidad ---
    entropy: number            // Shannon entropy sobre deltas recientes (0=predecible, 1=caótico)
    volatility: number         // desviación estándar de cambios recientes
    streak: number             // racha de cambios en misma dirección (+positiva, -negativa)
    streakRecord: number       // racha más larga histórica

    // --- Ciclo de vida ---
    lifecycle: LifecycleStage  // clasificación automática
    lifecycleChangedAt: number // cuándo cambió de stage
    tierHistory: TierEvent[]   // últimas N transiciones entre tiers

    // --- Campos numéricos (por cada field del schema) ---
    fieldTrends: Map<string, FieldTrend>
  }

  LifecycleStage = "emerging" | "active" | "stable" | "declining" | "dormant" | "dead" | "resurrected"

  FieldTrend {
    ema: number                // Exponential Moving Average (valor suavizado)
    direction: "up" | "down" | "flat"
    magnitude: number          // % de cambio reciente
    min: number                // mínimo histórico
    max: number                // máximo histórico
    zScore: number             // desviación de la media (para anomalías)
  }
  ```
- Clasificación de lifecycle (automática, basada en velocity + recency):
  ```
  Rules:
    velocity > highThreshold AND writeCount < 10       → emerging
    velocity > highThreshold AND writeCount >= 10      → active
    velocity in [lowThreshold, highThreshold]           → stable
    velocity < lowThreshold AND velocity > 0            → declining
    lastWrite > dormantWindow AND velocity ≈ 0          → dormant
    lastWrite > deadWindow                              → dead
    lifecycle was "dead" AND new put() arrives           → resurrected
  ```
- Todos los cálculos son O(1) por put: EMA, running variance, z-score son actualizables incrementalmente.
- Storage: ItemBehavior se almacena en el propio MemTable como records especiales (prefijo `_insight/`) y se persisten como segmentos GICS normales con un meta-schema dedicado.

#### 3.2 Correlation Analyzer (cross-item intelligence)

**Qué:** Detecta relaciones entre items que ni el consumidor sabría buscar.

**Entregables:**
- **Co-movement detection:**
  - Mantiene ventana deslizante de cambios recientes por item
  - Calcula correlación de Pearson incremental entre pares "candidatos"
  - Candidatos: items que cambian en ventanas temporales similares (no se comparan todos contra todos)
  - Output: pares con |correlation| > threshold (default 0.7)
  ```
  Correlation {
    itemA: string
    itemB: string
    coefficient: number        // -1.0 a 1.0
    direction: "positive" | "negative"
    lag: number                // períodos de desfase (0 = simultáneo)
    confidence: number         // basado en sample size
    since: number              // desde cuándo se observa
  }
  ```

- **Cluster detection:**
  - Agrupa items con correlaciones mutuas fuertes
  - Algoritmo: union-find sobre pares correlacionados
  - Output: clusters de items que se comportan como unidad
  ```
  Cluster {
    id: string
    members: string[]
    cohesion: number           // correlación media intra-cluster
    dominantLifecycle: LifecycleStage
    label?: string             // auto-generado si el schema lo permite
  }
  ```

- **Leading indicators:**
  - Detecta pares donde un item cambia antes que otro consistentemente
  - Usa cross-correlation con lag shift
  - Output: "item A predice item B con N períodos de adelanto"
  ```
  LeadingIndicator {
    leader: string
    follower: string
    lagPeriods: number
    predictiveStrength: number // 0.0 a 1.0
    sampleSize: number
  }
  ```

- **Seasonal patterns:**
  - Descomposición básica: media móvil para tendencia, residuo para seasonalidad
  - Detecta periodicidad (diaria, semanal, mensual) via autocorrelación
  - Output: "item X tiene ciclo semanal con pico los martes"
  ```
  SeasonalPattern {
    item: string
    period: "daily" | "weekly" | "monthly" | "custom"
    periodLength: number       // en horas
    peakOffset: number         // offset dentro del período donde está el pico
    amplitude: number          // magnitud del efecto estacional
    confidence: number
  }
  ```

- **Costo computacional:** O(K) por put, donde K = número de correlaciones activas que involucran al item modificado. K está acotado por configuración (default max 50 correlaciones por item).

#### 3.3 Predictive Signals

**Qué:** Convierte patterns en señales accionables. GICS no solo describe lo que pasó — anticipa lo que va a pasar.

**Entregables:**
- **Trend forecast:**
  - Proyección simple basada en EMA + momentum actual
  - No intenta ser un modelo ML complejo — es una estimación estadística honesta
  ```
  TrendForecast {
    item: string
    field: string
    currentValue: number
    projectedValue: number     // estimación a N períodos
    horizon: number            // períodos proyectados
    confidence: number         // decae con el horizonte
    basis: "ema" | "linear" | "seasonal_adjusted"
  }
  ```

- **Anomaly alerts:**
  - Basado en z-score: si el cambio actual está a > 2σ de la media → anomalía
  - Severity basada en magnitud de desviación
  ```
  Anomaly {
    item: string
    field: string
    expectedValue: number
    actualValue: number
    zScore: number
    severity: "low" | "medium" | "high" | "critical"
    timestamp: number
  }
  ```

- **Recommendations:**
  - Generadas por reglas sobre los insights computados
  - Cada recomendación tiene un `insightId` único para tracking
  ```
  Recommendation {
    insightId: string          // ID único para feedback loop
    type: "promote" | "demote" | "alert" | "investigate" | "act"
    target: string             // item key
    message: string            // descripción legible
    confidence: number
    basis: string[]            // qué insights la soportan
    expiresAt: number          // recomendación válida hasta...
  }
  ```
- Ejemplos de recomendaciones auto-generadas:
  ```
  GIMO context:
    "file_write|src/auth.py|sonnet tiende a auto_approve (score 0.94, 47 approvals).
     Recomendar: promover a auto_approve."
    basis: [behavioral.velocity.high, behavioral.streak.positive.23]

  WoW context:
    "Item 12345 (Elixir of Speed) entrando en patrón que históricamente precedió
     subida de 40%. Lead indicator: Item 67890 subió hace 2 días."
    basis: [leading_indicator.67890→12345.lag2, trend.12345.bullish]

  Nutrición context:
    "Ingesta de vitamina D declinando 3 semanas consecutivas. Históricamente
     correlaciona con caída de energía reportada en semana 4."
    basis: [trend.vitD.declining.3w, correlation.vitD↔energy.lag1w]
  ```

#### 3.4 Insight Schema (GICS almacena su propia inteligencia)

**Qué:** Los insights se almacenan como datos GICS normales, usando schemas dedicados. GICS se come su propio dogfood.

**Entregables:**
- Schema para behavioral metadata:
  ```
  SchemaProfile {
    id: "gics_insight_behavioral_v1"
    itemIdType: "string"
    fields: [
      { name: "velocity",     type: "numeric", codecStrategy: "value" }
      { name: "entropy",      type: "numeric", codecStrategy: "value" }
      { name: "lifecycle",    type: "categorical", enumMap: { emerging:0, active:1, stable:2, declining:3, dormant:4, dead:5, resurrected:6 } }
      { name: "writeCount",   type: "numeric", codecStrategy: "structural" }
      { name: "streak",       type: "numeric", codecStrategy: "structural" }
    ]
  }
  ```
- Schema para correlations:
  ```
  SchemaProfile {
    id: "gics_insight_correlation_v1"
    itemIdType: "string"       // "itemA|itemB" como key compuesta
    fields: [
      { name: "coefficient",  type: "numeric", codecStrategy: "value" }
      { name: "lag",          type: "numeric", codecStrategy: "structural" }
      { name: "confidence",   type: "numeric", codecStrategy: "value" }
      { name: "direction",    type: "categorical", enumMap: { positive:0, negative:1 } }
    ]
  }
  ```
- Los insights se persisten con el mismo ciclo HOT → WARM → COLD que los datos normales
- Resultado: puedes hacer `GICS.verify()` sobre archivos de insights igual que sobre datos — la inteligencia es auditable y verificable

**Resultado Fase 3:** Cada dato que entra en GICS genera metadata de comportamiento. GICS detecta correlaciones, clasifica ciclos de vida, proyecta tendencias, y genera recomendaciones accionables. Todo incremental, todo auditable, todo domain-agnostic.

---

### FASE 4: Cognitive Feedback Loop (semanas 9-10)
**Objetivo:** GICS aprende de los resultados. Los consumidores reportan si las recomendaciones fueron útiles, y GICS ajusta su confianza.

> **Esto es lo que convierte a GICS de "analytics" a "cognitivo".** No solo observa — aprende.

#### 4.1 Outcome Reporting

**Qué:** El consumidor reporta el resultado de seguir (o ignorar) una recomendación.

**Entregables:**
- API: `reportOutcome(insightId, result, context?)`
  ```
  Outcome {
    insightId: string           // referencia a la Recommendation original
    result: "followed_success"  // seguimos la recomendación y fue correcta
           | "followed_failure" // seguimos la recomendación y fue incorrecta
           | "ignored_validated" // la ignoramos y la predicción se cumplió igual
           | "ignored_invalid"  // la ignoramos y la predicción era incorrecta
           | "expired"          // no se actuó antes de expiración
    context?: string            // nota libre del consumidor
    timestamp: number
  }
  ```
- Cada outcome se vincula al insight original y actualiza métricas de confianza

#### 4.2 Confidence Adjustment

**Qué:** La confianza de cada tipo de insight se ajusta según los outcomes reportados.

**Entregables:**
- Modelo de confianza por tipo de insight:
  ```
  InsightConfidence {
    insightType: string         // "trend_forecast", "anomaly", "correlation", "recommendation"
    scope: string               // schema_id o "*" para global
    totalPredictions: number
    correctPredictions: number
    accuracy: number            // correct / total
    recentAccuracy: number      // accuracy últimas N predicciones (ventana deslizante)
    calibration: number         // qué tan bien correlaciona confidence estimada vs accuracy real
  }
  ```
- Adjustment rules:
  ```
  Si accuracy < 0.5 para un tipo de insight en un scope:
    → Reducir confidence de futuras predicciones de ese tipo
    → Si accuracy < 0.3: desactivar ese tipo para ese scope + log warning

  Si accuracy > 0.8:
    → Aumentar confidence de futuras predicciones
    → Si accuracy > 0.95 con N > 50: marcar como "high_reliability"
  ```
- Los ajustes son graduales (no binarios) para evitar oscillation
- Dashboard de accuracy por tipo de insight disponible via API

#### 4.3 Event Subscriptions

**Qué:** Los consumidores pueden suscribirse a eventos en tiempo real en vez de hacer polling.

**Entregables:**
- Tipos de eventos suscribibles:
  ```
  EventType:
    "tier_change"              // item se movió entre tiers
    "lifecycle_change"         // item cambió de lifecycle stage
    "anomaly_detected"         // z-score > threshold
    "correlation_discovered"   // nueva correlación significativa
    "recommendation_new"       // nueva recomendación generada
    "cluster_formed"           // nuevo cluster detectado
    "cluster_dissolved"        // cluster ya no tiene cohesión suficiente
  ```
- Mecanismo: streaming sobre la conexión IPC existente
  ```
  → { "method": "subscribe", "params": { "events": ["anomaly_detected", "recommendation_new"] }, "id": 10 }
  ← { "result": { "subscriptionId": "sub_abc123" }, "id": 10 }

  // Posteriormente, push desde el daemon:
  ← { "method": "event", "params": { "subscriptionId": "sub_abc123", "type": "anomaly_detected", "data": {...} } }
  ```
- El Python client expone esto como async iterator o callback

#### 4.4 Cold-Start Intelligence

**Qué:** Cuando un item nuevo aparece (zero history), GICS usa correlaciones y clusters existentes para estimar un behavioral profile inicial.

**Entregables:**
- Proceso:
  1. Nuevo item `put("file_write|src/auth_v2.py|sonnet|refactor", ...)`
  2. GICS no tiene historia para esta key exacta
  3. Busca keys similares por prefijo parcial:
     - `file_write|src/auth*` → match en cluster de "auth operations"
     - `*|*|sonnet|refactor` → match en cluster de "sonnet refactors"
  4. Genera ItemBehavior inicial basado en la media del cluster más relevante
  5. Marca como `lifecycle: "emerging"` con `confidence: inherited`
- Resultado: el Trust Engine de GIMO no arranca de cero para dimensiones nuevas — tiene un prior informado
- El prior se ajusta rápidamente con datos reales (EMA le da peso al dato nuevo)

**Resultado Fase 4:** GICS es cognitivo. Genera recomendaciones, recibe feedback, ajusta su confianza. Resuelve el cold-start problem. Los consumidores se suscriben a eventos en tiempo real.

---

## API Reference (nueva API pública de GICS 1.3.2)

### Operaciones CRUD
```
put(key, fields)              → { ok: true }
get(key)                      → { key, fields, tier, behavior? }
delete(key)                   → { ok: true }
scan(prefix?, limit?)         → { items: [...] }
```

### Operaciones de gestión
```
flush()                       → { segmentCreated, recordsFlushed }
compact()                     → { segmentsMerged, spaceReclaimed }
rotate()                      → { filesArchived, filesDeleted }
verify(tier?)                 → { valid: bool, details: [...] }
ping()                        → { uptime, memtableSize, segments, tiers }
```

### Operaciones de inteligencia
```
getInsight(key)               → ItemBehavior
getInsights(filter?)          → ItemBehavior[]
getCorrelations(key?)         → Correlation[]
getClusters()                 → Cluster[]
getLeadingIndicators(key?)    → LeadingIndicator[]
getSeasonalPatterns(key?)     → SeasonalPattern[]
getRecommendations(filter?)   → Recommendation[]
getAnomalies(since?)          → Anomaly[]
getForecast(key, field, horizon?) → TrendForecast
```

### Operaciones cognitivas
```
reportOutcome(insightId, result, context?)  → { ok: true }
getAccuracy(insightType?, scope?)           → InsightConfidence
subscribe(eventTypes)                       → subscriptionId
unsubscribe(subscriptionId)                 → { ok: true }
```

### Backward compatibility
```
// La API estática de v1.3.1 sigue funcionando exactamente igual:
GICS.pack(snapshots, options)     // encode directo
GICS.unpack(data, options)        // decode directo
GICS.verify(data)                 // verificación directa
GICS.schemas.TRUST_EVENTS         // schemas predefinidos
```

---

## Integración con GIMO

Con GICS 1.3.2, la Fase 1 y Fase 4 del roadmap GIMO se simplifican:

### Antes (con SQLite):
```
GIMO → SQLite (HOT) → GICS (WARM) → GICS+AES (COLD)
  + trust_engine.py calcula scores
  + institutional_memory.py detecta patrones
  + custom rotation logic
```

### Después (con GICS 1.3.2):
```
GIMO → GICS daemon (HOT+WARM+COLD automático)
  + Trust Engine solo consulta insights que GICS ya computó
  + Institutional Memory = GICS Insight Engine
  + Rotation = automática por GICS Tier Engine
```

**Lo que GIMO ya no necesita construir:**
- ~~SQLite persistence layer~~ → GICS MemTable + WAL
- ~~Trust record storage~~ → GICS put/get con TRUST_EVENTS schema
- ~~Rotación manual de tiers~~ → GICS Tier Engine automático
- ~~Pattern detection para Institutional Memory~~ → GICS Insight Engine
- ~~Cold-start heuristics~~ → GICS Cold-Start Intelligence

**Lo que GIMO sigue haciendo (su valor añadido):**
- Policy decisions (auto_approve / require_review / blocked)
- HITL workflow (approval gates)
- Agent Adapters (Claude Code, Codex, Gemini)
- Graph Engine (workflow execution)
- Contract verification (pre/post conditions)

---

## Casos de uso multi-dominio

| Dominio | Schema | Insights clave |
|---------|--------|----------------|
| **GIMO (gobernanza)** | `gimo_trust_v1` | Trust trends, agent reliability clusters, cold-start para dimensiones nuevas, anomalías en patrones de approval |
| **Gred-In Labs (WoW)** | `market_data_v1` | Leading indicators entre items, seasonal patterns (raids), lifecycle de items (emerging→dead), anomaly alerts para spikes |
| **Nutrición** | Custom nutrition schema | Trend de ingesta por nutriente, correlación entre nutrientes y síntomas, seasonal eating patterns, deficiency alerts |
| **Medicina** | Custom clinical schema | Patient response trends, treatment correlation, anomaly detection para efectos adversos, lifecycle de tratamientos |

**El mismo GICS daemon sirve a todos.** Solo cambia el schema. La inteligencia es domain-agnostic.

---

## Stack técnico

| Componente | Tecnología | Notas |
|---|---|---|
| Runtime | Node.js >= 18 | Mismo que v1.3.1 |
| IPC | Unix socket / Named pipe | JSON-RPC 2.0 |
| MemTable | `Map<string, MemRecord>` nativo | O(1) get/put |
| WAL | Binary append-only file | CRC32 por entry |
| Segmentos | GICS v1.3 format (sin cambios) | Retrocompatible |
| Cifrado | AES-256-GCM (sin cambios) | Solo COLD tier |
| Integridad | SHA-256 chain + CRC32 (sin cambios) | Todos los tiers |
| Stats | Incremental (EMA, running variance, Pearson) | O(1) por put |
| Dependencias nuevas | **Cero** | Todo con Node.js stdlib |

**Invariante:** Cero dependencias nuevas en runtime. El Insight Engine usa estadística incremental pura (EMA, z-score, Pearson online, Shannon entropy). No hay ML, no hay numpy, no hay black boxes. Todo es determinista, explicable, y auditable.

---

## Timeline

| Fase | Semanas | Entregable |
|---|---|---|
| **1: Daemon Core** | 1-2 | MemTable + WAL + IPC Server + Python Client + File Locking |
| **2: Tier Engine** | 3-4 | Flush automático + Compactación + Rotación WARM→COLD + Tier Index |
| **3: Insight Engine** | 5-8 | Behavioral Tracker + Correlation Analyzer + Predictive Signals + Insight Schemas |
| **4: Feedback Loop** | 9-10 | Outcome Reporting + Confidence Adjustment + Subscriptions + Cold-Start |

**Total estimado: 10 semanas de desarrollo.**

**Dependencia con GIMO:** GIMO Fase 1 puede arrancar en paralelo con GICS Fase 1. Cuando GICS daemon esté listo (semana 2), GIMO puede integrarse inmediatamente. El Insight Engine (semana 5-8) alimenta directamente la Institutional Memory de GIMO Fase 4.

---

## Invariantes (heredadas de v1.3.1 + nuevas)

1. **Fail-closed:** ante duda, bloquear. WAL corrupto → replay parcial + warning, nunca inventar datos.
2. **Determinismo:** mismos datos + misma config → mismos insights. No hay randomness.
3. **Backward-compatible:** GICS.pack/unpack/verify siguen funcionando sin daemon. El daemon es opt-in.
4. **Cero dependencias nuevas:** todo con Node.js stdlib. Estadística incremental pura.
5. **Insights son datos:** se almacenan como GICS, se verifican como GICS, se cifran como GICS.
6. **Domain-agnostic:** la inteligencia emerge del schema + data patterns, nunca de lógica hardcodeada.
7. **Auditable:** cada insight tiene basis (qué datos lo soportan), cada recomendación tiene insightId (traceable).
8. **Cognitivo, no mágico:** estadística honesta con confidence scores. Nunca presenta una estimación como certeza.
