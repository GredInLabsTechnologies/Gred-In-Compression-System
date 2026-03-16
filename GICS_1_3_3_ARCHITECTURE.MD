# GICS 1.3.3 — Arquitectura de siguiente generacion

> **Objetivo:** Convertir GICS de un key-value store con insight parcialmente conectado
> en un **motor de inteligencia determinista, resiliente y compresible** que sea
> un moat real, verificable, y que funcione sin dudar en las peores condiciones.
>
> **Principios inquebrantables:**
> 1. **Determinismo** — Dado el mismo input, siempre el mismo output. Sin excepciones.
> 2. **Crash-safety** — Durability guarantees explicitas por failure class. Sin poesia.
> 3. **Transparencia total** — Cada decision es auditable. Cero cajas negras.
> 4. **Compresion inteligente** — Los datos crecen logaritmicamente, no linealmente.
> 5. **Zero silent failures** — Si algo falla, se sabe, se registra, se recupera.
> 6. **Presupuesto de complejidad** — Ningun modulo entra si no mejora una metrica o elimina un riesgo real.

> **Revision 2 — 15 marzo 2026**
> Incorpora correcciones de auditoria externa:
> - CausalGraph renombrado a LaggedInfluenceGraph (no es causalidad real)
> - Fallback in-memory acotado a modo degradado limitado (no "inmortalidad")
> - MemTable tiered movido a prioridad peligrosa (cirugia mayor)
> - "Zero data loss" reemplazado por durability guarantees por failure class
> - Anadidos: invariantes formales, plan de migracion, presupuesto de complejidad
> - Re-priorizado roadmap segun riesgo real vs valor

---

## Tabla de contenidos

- [1. Diagnostico actual](#1-diagnostico-actual)
- [2. Arquitectura objetivo](#2-arquitectura-objetivo)
- [3. Durability guarantees](#3-durability-guarantees)
- [4. Modulos: invariantes formales](#4-modulos-invariantes-formales)
- [5. Plan de migracion desde 1.3.x](#5-plan-de-migracion-desde-13x)
- [6. Presupuesto de complejidad](#6-presupuesto-de-complejidad)
- [7. Roadmap priorizado](#7-roadmap-priorizado)
- [8. Protocolos de resiliencia](#8-protocolos-de-resiliencia)
- [Fuentes y referencias](#fuentes-y-referencias)

---

## 1. Diagnostico actual

### Lo que funciona
- MemTable con WAL basico
- InsightTracker con lifecycle stages, velocity, entropy, field trends
- CorrelationAnalyzer con Pearson, clusters, leading indicators, seasonal patterns
- PredictiveSignals con anomalias z-score, forecasts EMA, recomendaciones
- ConfidenceTracker con auto-calibracion de predicciones
- JSON-RPC daemon sobre named pipe (Windows) / Unix socket

### Lo que NO funciona o no esta conectado
- **Los clientes solo usan put/get/scan** — el 70% del Insight Engine esta desconectado
- **Sin compresion** — prompts, traces, logs crecen sin limite
- **Sin retention policy** — datos muertos ocupan el mismo espacio que datos activos
- **WAL basico** — sin checkpointing robusto, sin verificacion de integridad post-crash
- **Sin audit trail inmutable** — los datos se sobreescriben, no hay hash chain
- **Daemon como subprocess** — un punto de fallo unico sin recovery automatico
- **Sin backpressure** — si un cliente escribe mas rapido de lo que GICS puede procesar, se pierde
- **Sin circuit breaker** — si GICS falla, los clientes siguen llamando hasta timeout
- **Modelo de routing es blended lineal** — no explora alternativas (no es bandit)

---

## 2. Arquitectura objetivo

```
┌─────────────────────────────────────────────────────────────────┐
│                        GICS 1.3.3                               │
│                                                                 │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐   │
│  │ Ingest   │→│ WAL v2       │→│ MemTable               │   │
│  │ Pipeline │  │ (CRC+ckpt)  │  │ (current, unchanged)   │   │
│  └──────────┘  └──────────────┘  └────────────────────────┘   │
│       ↓                                    ↓                    │
│  ┌──────────┐                    ┌────────────────────────┐   │
│  │ Backpres │                    │ PromptDistiller        │   │
│  │ sure     │                    │ (retention + compress)  │   │
│  │ Valve    │                    └────────────────────────┘   │
│  └──────────┘                              ↓                    │
│                                  ┌────────────────────────┐   │
│  ┌─────────────────────────┐    │ Insight Engine v2      │   │
│  │ Resilience Layer        │    │ ┌────────────────────┐ │   │
│  │ ┌─────────┐ ┌────────┐ │    │ │ InsightTracker     │ │   │
│  │ │Circuit  │ │Retry + │ │    │ │ CorrelationAnalyzer│ │   │
│  │ │Breaker  │ │Jitter  │ │    │ │ PredictiveSignals  │ │   │
│  │ └─────────┘ └────────┘ │    │ │ ConfidenceTracker  │ │   │
│  │ ┌─────────┐            │    │ │ ★ BanditRouter     │ │   │
│  │ │Timeout  │            │    │ └────────────────────┘ │   │
│  │ │Guard    │            │    └────────────────────────┘   │
│  │ └─────────┘            │              ↓                    │
│  └─────────────────────────┘    ┌────────────────────────┐   │
│                                  │ AuditChain             │   │
│  ┌─────────────────────────┐    │ (Merkle hash chain)    │   │
│  │ GICSSupervisor          │    └────────────────────────┘   │
│  │ (auto-restart+degraded) │              ↓                    │
│  └─────────────────────────┘    ┌────────────────────────┐   │
│                                  │ Query Interface        │   │
│                                  │ (JSON-RPC + suggest)   │   │
│                                  └────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

Modulos aplazados (prioridad peligrosa, no en 1.3.3 inicial):
  - MemTable tiered (HOT/WARM/COLD)
  - LaggedInfluenceGraph (ex-CausalGraph)
  - Auto-act basado en confidence >80%
```

---

## 3. Durability guarantees

> Reemplaza la promesa anterior de "zero data loss".
> Define exactamente que se pierde y que no bajo cada tipo de fallo.

### Failure classes

| Failure class | Guarantee | Condicion | Ack semantics |
|---|---|---|---|
| **Daemon crash post-fsync** | Durable | WAL entry en disco, recovery la aplica | put() retorno OK = dato sobrevive daemon crash |
| **Daemon crash pre-fsync** | Lost (1 entry max) | `fsyncOnCommit=true` reduce ventana a ~0 | put() no retorno = dato puede o no estar |
| **Host crash (power loss)** | Durable hasta ultimo fsync | Depende de OS page cache | Solo garantizado si `fsyncOnCommit=true` + hardware con battery-backed cache |
| **Disk corruption** | Detectable, no recoverable | CRC detecta entry corrupta, skip+warning | Dato perdido pero sistema no se corrompe en cascada |
| **Fallback buffer no flushed** | Lost | Buffer en memoria no es durable | Documentado como best-effort |
| **Network partition** | Buffered, at-least-once | Retry con idempotency keys | Caller debe tolerar duplicados |

### Semantica de ack

```
put() retorna OK
  → WAL entry escrita en disco (si fsyncOnCommit=true: fsync completado)
  → Dato sobrevive a daemon crash
  → Dato NO necesariamente sobrevive a host crash si fsyncOnCommit=false

put() retorna timeout/error
  → Dato PUEDE o NO haberse escrito
  → Caller DEBE retry con idempotency key
  → GICS garantiza at-least-once, NO exactly-once

put() en modo DEGRADED (fallback)
  → Dato en memoria temporal, NO durable
  → Se intenta flush cuando daemon revive
  → Si host muere antes de flush: dato perdido
  → Operaciones permitidas en DEGRADED: solo reads del ultimo snapshot + buffered writes
  → Operaciones NO permitidas en DEGRADED: routing decisions basadas en datos nuevos
```

---

## 4. Modulos: invariantes formales

> Para cada modulo: que entra, que sale, que estado toca, que invariantes mantiene, que semantica de error tiene.

### 4.1 — WAL v2

**Input:** `(op: put|delete, key: string, fields: Record<string, number|string>)`
**Output:** `(lsn: number)` — Log Sequence Number asignado, monotonicamente creciente
**Estado que toca:** Archivo WAL en disco, archivo de checkpoint
**Invariantes:**
- `lsn(entry_N+1) > lsn(entry_N)` siempre
- Cada entry tiene CRC32 verificable independientemente
- Checkpoint contiene SHA-256 del MemTable state en ese punto
- Recovery desde checkpoint + replay produce estado identico al pre-crash (determinismo)
- Si `fsyncOnCommit=true`: entry con LSN devuelto sobrevive a daemon crash
- WAL nunca crece mas de `maxWalSizeMB` — auto-compact tras checkpoint

**Error semantics:**
- Write falla → no se asigna LSN, caller recibe error, estado no cambia
- CRC invalido en recovery → entry se skipea, warning logueado, recovery continua
- Checkpoint corrupto → se busca checkpoint anterior valido, si ninguno → replay completo

```typescript
interface WALv2Config {
  checkpointEveryOps: number;      // default: 500
  checkpointEveryMs: number;       // default: 30000
  maxWalSizeMB: number;            // default: 50
  fsyncOnCommit: boolean;          // default: true (safety > speed)
}

interface WALEntry {
  lsn: number;              // Log Sequence Number (monotonic)
  crc: number;              // CRC32 of payload
  timestamp: number;
  op: 'put' | 'delete';
  key: string;
  fields: Record<string, number | string>;
}
```

### 4.2 — ResilienceShell (Circuit Breaker + Retry + Backpressure)

**Input:** Cualquier comando GICS (`put`, `get`, `scan`)
**Output:** Resultado del comando o error tipado (`GICSUnavailable`, `GICSTimeout`, `GICSCircuitOpen`)
**Estado que toca:** Contadores de failure/success, estado del circuit breaker, cola de backpressure
**Invariantes:**
- Circuit breaker: CLOSED → (N failures in window) → OPEN → (cooldown) → HALF-OPEN → (probes) → CLOSED/OPEN
- En OPEN: todas las calls fallan inmediatamente con `GICSCircuitOpen` (no timeout)
- Retry: exponential backoff con jitter, max N intentos, nunca retry si circuit OPEN
- Backpressure: si pending writes > highWaterMark → signal "slow down" al caller
  - `block` strategy: caller espera hasta lowWaterMark
  - `drop-oldest` strategy: descarta writes mas viejos del queue
  - En ningun caso se pierden silenciosamente — siempre se loguea

**Error semantics:**
- `GICSUnavailable`: daemon no responde, circuit breaker activado
- `GICSTimeout`: comando individual excedio timeout
- `GICSCircuitOpen`: circuit breaker abierto, fail-fast sin intentar
- Todos los errores llevan metadata: `{attempts, lastError, circuitState, queueDepth}`

```typescript
interface ResilienceConfig {
  circuitBreaker: {
    failureThreshold: number;     // default: 5
    windowMs: number;             // default: 60000
    halfOpenAfterMs: number;      // default: 30000
    halfOpenMaxProbes: number;    // default: 3
  };
  backpressure: {
    highWaterMark: number;        // default: 1000
    lowWaterMark: number;         // default: 200
    strategy: 'drop-oldest' | 'block';
  };
  retry: {
    maxAttempts: number;          // default: 3
    baseDelayMs: number;          // default: 100
    maxDelayMs: number;           // default: 5000
    jitterFactor: number;         // default: 0.3
  };
  timeout: {
    readMs: number;               // default: 2000
    writeMs: number;              // default: 5000
    scanMs: number;               // default: 10000
  };
}
```

### 4.3 — GICSSupervisor

**Input:** Daemon process reference
**Output:** Estado del daemon (`STARTING`, `HEALTHY`, `RESTARTING`, `DEGRADED`)
**Estado que toca:** subprocess handle, restart counter, health check timer
**Invariantes:**
- Health check cada N segundos (default: 10)
- Si daemon muere: restart con exponential backoff (1s, 2s, 4s, 8s, 16s)
- Si 5 restarts fallan en 5 minutos → DEGRADED mode
- DEGRADED mode requiere intervencion manual para salir
- En DEGRADED: el daemon usa buffer in-memory temporal (ver durability guarantees)
- Todos los transitions de estado se loguean con timestamp

**Error semantics:**
- DEGRADED emite alerta critica al dashboard + log
- Supervisor nunca crashea el daemon — peor caso es DEGRADED, no crash

```
STARTING → HEALTHY → (daemon dies) → RESTARTING → HEALTHY
                                    → (5 fails in 5min) → DEGRADED → (manual reset) → STARTING
```

### 4.4 — AuditChain (Merkle Hash Chain)

**Input:** Cualquier mutacion: `(actor, action, target, payload)`
**Output:** `AuditEntry` con hash encadenado al anterior
**Estado que toca:** Archivo append-only de audit, merkle checkpoints
**Invariantes:**
- Append-only: nunca se modifica ni se borra una entry existente
- `entry.hash = SHA-256(sequence + timestamp + actor + action + target + payload + prevHash)`
- `entry.sequence` monotonicamente creciente, sin gaps
- Merkle checkpoint cada N entries (default: 1000): root hash del batch
- Verificacion: cualquier entry es verificable con solo las entries adyacentes
- Tamper-evident: modificar 1 byte invalida toda la cadena posterior

**Error semantics:**
- Si no se puede escribir audit entry → la operacion original TAMBIEN falla (audit es mandatory)
- Si disco lleno → AuditChain es el ultimo servicio en entrar en read-only (prioridad maxima)
- Export en formato JSON lines para herramientas de compliance externas

```typescript
interface AuditEntry {
  sequence: number;
  timestamp: number;
  actor: string;       // "gimo:agent:planner" | "user:admin" | "system:scheduler"
  action: string;      // "put" | "delete" | "route" | "execute" | "approve"
  target: string;      // key affected
  payload: string;     // JSON of change (or SHA-256 hash if sensitive)
  prevHash: string;
  hash: string;
}
```

### 4.5 — PromptDistiller (Retention + Compresion)

**Input:** Key + fields que contienen datos de alta volatilidad (prompts, traces, logs)
**Output:** Datos comprimidos o destilados segun antiguedad
**Estado que toca:** Archivos de cold storage (ZSTD), metadata de retention
**Invariantes:**
- 3 capas con transicion automatica:
  - Raw (dia 0-7): datos completos, acceso instantaneo
  - Compressed (dia 7-30): delta-encoded + ZSTD, acceso <10ms
  - Distilled (dia 30+): solo metadata semantica (~200 bytes), permanente
- La transicion entre capas NUNCA pierde metadata (tokenCount, model, success, cost, etc.)
- La transicion Raw→Compressed es reversible (decompress = original)
- La transicion Compressed→Distilled es IRREVERSIBLE (prompt original se pierde)
- Emergency purge si disco > emergencyPurgeThreshold:
  1. Raw > 3 dias → purge
  2. Compressed > 15 dias → purge
  3. Si aun > threshold → aggregate distilled por semana
- Disk usage check cada N minutos (default: 5)

**Error semantics:**
- Si compresion falla → datos permanecen en capa anterior (no se pierden)
- Si disco lleno durante compresion → GICS entra en READ-ONLY mode
- Cada purge se registra en AuditChain con detalle de que se elimino

```typescript
interface DistillationConfig {
  rawRetentionDays: number;        // default: 7
  compressedRetentionDays: number; // default: 30
  compressionCodec: 'zstd' | 'lz4'; // default: zstd
  maxDiskUsageMB: number;          // default: 500
  emergencyPurgeThreshold: number; // default: 0.9
  checkIntervalMs: number;         // default: 300000 (5 min)
}
```

### 4.6 — PredictiveSignals + ConfidenceTracker wiring (suggest-only)

**Input:** ItemBehavior updates del InsightTracker (automatico en cada put/get)
**Output:** Recommendations tipadas emitidas via event stream
**Estado que toca:** Lista de recommendations activas, accuracy counters en ConfidenceTracker
**Invariantes:**
- En 1.3.3: **solo modo suggest-only**. Recomendaciones se emiten pero NO se auto-ejecutan
- Cada recomendacion tiene TTL (default: 24h), se auto-expira
- ConfidenceTracker registra outcomes cuando el cliente (o el usuario) sigue/ignora una recomendacion
- Si accuracy de un tipo de recomendacion cae < 50% tras 20+ outcomes → se desactiva automaticamente
- Recomendaciones desactivadas se loguean con razon en AuditChain
- Auto-act (ejecutar recomendaciones automaticamente si confidence > threshold) **NO se implementa en 1.3.3**
  - Razon: riesgo de feedback loops incontrolados. Requiere mas datos empiricos primero.
  - Se re-evalua cuando haya 500+ recorded outcomes con accuracy estable

**Error semantics:**
- Si InsightTracker falla en onWrite/onRead → la operacion original NO falla (insight es best-effort)
- Si PredictiveSignals emite recomendacion invalida → ConfidenceTracker la penaliza via accuracy

### 4.7 — BanditRouter (detras de feature flag)

**Input:** `(taskType: string, constraints: {maxTier, maxCostUsd, maxLatencyMs})`
**Output:** `(modelId, providerId, expectedReward, explorationRatio)`
**Estado que toca:** Beta distribution params (alpha, beta) por arm en GICS MemTable
**Invariantes:**
- Cada modelo+taskType es un "arm" con distribucion Beta(alpha, beta)
- Seleccion: sample de cada Beta, ajustar por coste/latencia, elegir el mas alto
- Observe: `success → alpha += 1`, `failure → beta += 1`
- Temporal decay: cada dia, `alpha *= decayRate`, `beta *= decayRate` (previene lock-in)
- `explorationFloor`: ningun modelo seleccionado >95% de las veces (5% minimo de exploracion)
- Cold start: modelo nuevo empieza con Beta(coldStartBonus, 1)
- **Determinista dado el seed**: si fijas random seed, seleccion es reproducible (para testing)
- Feature flag: `GICS_BANDIT_ENABLED=true`. Si false, se usa blended score actual como fallback

**Error semantics:**
- Si no hay arms disponibles → fallback a blended score actual (never fail)
- Si arm seleccionado no responde → observe(failure) + retry con siguiente arm
- Transicion de blended score a bandit: A/B test obligatorio con 1000+ decisions antes de activar

```typescript
interface BanditConfig {
  temporalDecayRate: number;     // default: 0.995 per day
  explorationFloor: number;      // default: 0.05
  coldStartBonus: number;        // default: 3
  costPenaltyWeight: number;     // default: 0.1
  latencyPenaltyWeight: number;  // default: 0.05
  randomSeed?: number;           // for deterministic testing
}
```

---

## 5. Plan de migracion desde 1.3.x

> Critico. No basta con decir "fases". Hay que definir como migrar sin romper.

### 5.1 — WAL v1 → WAL v2

| Aspecto | Estrategia |
|---------|-----------|
| Formato | WAL v2 anade header con magic bytes + version number. V2 reader detecta v1 entries por ausencia de header |
| Migracion | Al arrancar, si WAL no tiene header v2 → se trata como v1 (replay completo, sin CRC check). Despues del primer checkpoint v2, el WAL es v2 |
| Rollback | Si hay que volver a v1: el MemTable snapshot en el checkpoint es compatible. Se pierde CRC verification pero no datos |
| Riesgo | Bajo. V2 es superset de v1 |

### 5.2 — Introducir AuditChain

| Aspecto | Estrategia |
|---------|-----------|
| Formato | Archivo separado (`audit.chain`), no afecta WAL ni MemTable |
| Migracion | Se activa en el proximo arranque. No hay datos historicos → chain empieza desde sequence=0 |
| Rollback | Borrar `audit.chain`. Ninguna otra parte del sistema depende de el |
| Riesgo | Muy bajo. Es write-only y no afecta reads |

### 5.3 — PromptDistiller

| Aspecto | Estrategia |
|---------|-----------|
| Formato | Datos raw existentes siguen siendo raw. El distiller solo actua sobre datos nuevos y sobre datos existentes que superen rawRetentionDays |
| Migracion | Primera ejecucion: escanea datos existentes, clasifica por edad, comprime los que excedan retention |
| Rollback | Datos compressed se pueden descomprimir. Datos distilled son irreversibles — pero solo se destilan datos de >30 dias |
| Riesgo | Medio. La primera compresion de datos historicos puede ser lenta. Hacer en background con limiter |

### 5.4 — BanditRouter (detras de flag)

| Aspecto | Estrategia |
|---------|-----------|
| Formato | Arms se guardan como records GICS normales (`ops:bandit:{provider}:{model}:{taskType}`) |
| Migracion | Cold start: todos los arms se inicializan desde datos existentes de `record_model_outcome`. Alpha = successes + 1, beta = failures + 1 |
| Rollback | `GICS_BANDIT_ENABLED=false` → vuelve a blended score instantaneamente. Arms se quedan en GICS pero no se consultan |
| Riesgo | Bajo si esta detras de flag. Alto si se activa sin A/B test |

### 5.5 — ResilienceShell

| Aspecto | Estrategia |
|---------|-----------|
| Formato | Middleware interno sobre la capa JSON-RPC del daemon. No cambia protocolo |
| Migracion | Reemplazar `_send_with_retry` con ResilienceShell. Misma API, mejor semantica |
| Rollback | Revertir a `_send_with_retry` (un revert de 1 archivo) |
| Riesgo | Bajo. Es transparente para callers |

---

## 6. Presupuesto de complejidad

> **Ley de hierro:** Ningun modulo entra si no mejora claramente una metrica o elimina un riesgo real.

### Criterio de admision por modulo

| Modulo | Metrica que mejora | Riesgo que elimina | LOC estimado | Dependencias nuevas | Veredicto |
|--------|-------------------|-------------------|--------------|--------------------|----|
| WAL v2 | Recovery time, data integrity | Silent corruption, incomplete recovery | ~200 | 0 | **ENTRA** |
| ResilienceShell | Uptime, error handling | Silent failures, cascade crashes | ~150 | 0 | **ENTRA** |
| GICSSupervisor | Uptime | Single point of failure | ~100 | 0 | **ENTRA** |
| AuditChain | Auditability, compliance | Tampering, deniability | ~200 | 0 (SHA-256 nativo) | **ENTRA** |
| PromptDistiller | Disk usage (-10x a 30 dias) | Disk bloat, OOM | ~300 | zstd-napi (1 dep) | **ENTRA** |
| PredictiveSignals wiring | Deteccion de degradacion | Modelos fallando sin aviso | ~100 (wiring) | 0 (ya existe) | **ENTRA** |
| BanditRouter | Model selection quality (+24% vs UCB) | Lock-in a modelos suboptimos | ~250 | 0 | **ENTRA detras de flag** |
| InsightTracker wiring | Lifecycle-driven cleanup | Datos muertos sin limpiar | ~50 (wiring) | 0 (ya existe) | **ENTRA** |
| Health endpoint | Observability | Opacidad del sistema | ~80 | 0 | **ENTRA** |
| MemTable tiered | Memory efficiency | — | ~500+ | mmap dep | **APLAZADO** |
| LaggedInfluenceGraph | Explicabilidad | — | ~400+ | 0 | **APLAZADO** |
| Auto-act (confidence >80%) | Automatizacion | Feedback loops incontrolados | ~100 | 0 | **APLAZADO** |

### Complejidad total estimada para 1.3.3

- **Lineas nuevas:** ~1780 (TypeScript/daemon)
- **Dependencias nuevas:** 1 (zstd-napi para compresion)
- **Archivos nuevos:** ~8-10
- **Breaking changes:** 0 (todo aditivo o detras de flag)

### Regla de salida

Si durante la implementacion un modulo:
1. Supera 2x las LOC estimadas → revisar si se esta sobre-ingenierizando
2. Requiere cambios en >3 modulos existentes → revisar acoplamiento
3. No tiene test gate definido → no se mergea

---

## 7. Roadmap priorizado

> Re-priorizado segun auditoria. El orden refleja valor/riesgo real, no ambicion.

### Prioridad ABSOLUTA — El acero

> Esto ya te da un salto enorme sin convertir el sistema en una criatura de ocho cabezas.

| Orden | Modulo | Que hacer | Test gate |
|-------|--------|-----------|-----------|
| 1 | **WAL v2** | CRC por entry, checkpointing, recovery determinista. Header con version para compat con v1 | 100 crash-recovery cycles sin data loss. CRC detect corruption rate = 100% |
| 2 | **GICSSupervisor** | Auto-restart con backoff, DEGRADED mode, health check | Daemon killed 50 veces en 5 min → max 5 restarts, luego DEGRADED. Zero daemon crashes |
| 3 | **ResilienceShell** | Circuit breaker + retry+jitter + backpressure sobre GicsService Python | Circuit abre tras 5 failures, cierra tras probes OK. Backpressure limita queue a highWaterMark |
| 4 | **AuditChain** | Append-only log con Merkle hash chain. Cada put() genera entry | 10K entries → verify chain integrity = 100%. Tamper 1 entry → detection = 100% |
| 5 | **PromptDistiller basico** | Retention policy + ZSTD compression para datos >7 dias. Emergency purge | 30 dias simulados → disk usage <10% de raw. Emergency purge libera >50% en <10s |
| 6 | **PredictiveSignals + ConfidenceTracker wiring** | Conectar en modo suggest-only. Recomendaciones emitidas pero no auto-ejecutadas | Degradacion simulada de modelo → recomendacion emitida en <5s. Accuracy tracking funciona |

**Criterio de completitud:** Los 6 modulos pasan sus test gates. GICS puede morir, revivir, comprimir, auditar y sugerir sin romper nada.

### Prioridad MEDIA — Inteligencia controlada

| Orden | Modulo | Que hacer | Test gate |
|-------|--------|-----------|-----------|
| 7 | **BanditRouter (detras de flag)** | Thompson Sampling. Cold start desde datos existentes. Flag off por defecto | A/B test: 1000 decisiones, bandit vs blended. Bandit debe ganar en reward acumulado |
| 8 | **InsightTracker → lifecycle actions** | Cada put/get activa tracker. Lifecycle `dormant/dead` → trigger compresion | 10K ops → lifecycle transitions correctas. Datos dormant comprimidos automaticamente |
| 9 | **Health endpoint** | `/health/gics` con metricas: WAL size, circuit state, retention stats, daemon uptime | Endpoint responde en <100ms con datos actuales |

**Criterio de completitud:** BanditRouter activo detras de flag con datos de A/B test. InsightTracker conectado. Health observable.

### Prioridad PELIGROSA — Aqui empiezan los monstruos bonitos

> No se implementa en 1.3.3 inicial. Se re-evalua cuando Prioridad Absoluta + Media esten estables.

| Modulo | Por que es peligroso | Cuando re-evaluar |
|--------|---------------------|-------------------|
| **MemTable tiered (HOT/WARM/COLD)** | Toca el corazon del sistema. Bugs de recovery, pierde determinismo, complica debugging | Cuando haya evidencia de memory pressure en produccion real |
| **LaggedInfluenceGraph** (ex-CausalGraph) | No es causalidad real, es heuristica. Riesgo de "chaman estadistico con corbata" | Cuando CorrelationAnalyzer + PredictiveSignals tengan 500+ outcomes con accuracy estable |
| **Auto-act (confidence >80%)** | Feedback loops incontrolados. Si se equivoca, se equivoca automaticamente | Cuando ConfidenceTracker tenga 1000+ outcomes y accuracy consistente >80% durante 30 dias |

**Requisitos previos para desbloquear:**
- MemTable tiered: feature flag + test de integridad con 100K ops random + kill -9 random + verify all data
- LaggedInfluenceGraph: rename firme (no "causal"), documentar que es y que NO es, min 500 data points
- Auto-act: monitoring dashboard que muestre que decisiones se habrian tomado (dry-run mode) durante 30 dias antes de activar

---

## 8. Protocolos de resiliencia

### Escenario: Daemon crash mid-write

```
1. Cliente llama put("ops:model_score:...", fields) via JSON-RPC
2. ResilienceShell.write() → procesa en el daemon
3. Daemon escribe WAL entry + fsync ✓
4. Daemon crash antes de actualizar MemTable
5. Cliente recibe timeout → ResilienceShell marca como failure
6. Circuit Breaker: failure_count++
7. Supervisor detecta crash → restart con backoff
8. Daemon: recovery → lee WAL → busca ultimo checkpoint → replay desde ahi
9. Dato recuperado (estaba en WAL post-fsync).
10. Circuit Breaker: half-open → probe succeeds → closed
11. AuditChain: entry registrando crash + recovery + tiempo total

NOTA: Si daemon crash PRE-fsync, la entry puede perderse.
Esto es aceptable — el caller recibio timeout, sabe que debe retry.
```

### Escenario: Disco lleno

```
1. PromptDistiller.checkDiskUsage() → 91% (> emergencyPurgeThreshold)
2. Emergency purge activado:
   a. Purgar raw data > 3 dias
   b. Si aun > 90%: purgar compressed > 15 dias
   c. Si aun > 90%: agregar distilled por semana
3. AuditChain: entry "Emergency purge executed, freed X MB"
4. Alert al dashboard via log + health endpoint
5. Si disco sigue > 95%: GICS entra en READ-ONLY mode
6. En READ-ONLY: solo AuditChain puede escribir (ultima prioridad de disco)
7. Manual intervention required para salir de READ-ONLY
```

### Escenario: Modelo se degrada silenciosamente

```
1. BanditRouter selecciona GPT-4o para code task (Thompson sample = 0.87)
2. GPT-4o falla: 3 de 5 ultimas → beta crece de 5 a 8
3. InsightTracker: velocity de failures sube, lifecycle → "declining"
4. PredictiveSignals: anomalia (z-score = 2.3, severity = medium)
5. PredictiveSignals emite recomendacion: {type: "demote", target: "gpt-4o", confidence: 0.72}
6. Recomendacion emitida en modo suggest-only (NO auto-ejecutada en 1.3.3)
7. Dashboard muestra recomendacion al usuario/operador
8. Si usuario sigue recomendacion → ConfidenceTracker.recordOutcome("followed_success")
9. Si usuario ignora y GPT-4o sigue fallando → ConfidenceTracker.recordOutcome("ignored_invalid")
10. Mientras tanto, BanditRouter naturalmente reduce GPT-4o
    (Thompson sample baja porque beta crece), sin necesidad de intervencion
11. Todo queda en AuditChain: anomalia, recomendacion, decision, resultado
```

### Escenario: Fallback degradado (daemon irrecoverable)

```
1. Daemon crash → Supervisor restart
2. Restart falla 5 veces en 5 minutos
3. Supervisor → DEGRADED mode
4. Supervisor activa in-memory buffer (Map con writes append-only)
5. Reads: servidos desde ultimo MemTable snapshot (stale pero consistente)
6. Writes: buffered con sequence IDs monotonicos
7. Routing: usa ultimos datos conocidos, NO toma decisiones basadas en buffer
8. Alert critica: log + health endpoint → "GICS DEGRADED, manual intervention required"
9. Operador interviene → restart manual del daemon
10. Daemon arranca → recovery normal desde WAL
11. Supervisor: flush buffer al daemon con idempotency keys (at-least-once)
12. Orden de events preservado via sequence IDs
13. Si hay conflicto (key modificada en buffer Y en WAL durante recovery):
    → WAL wins (es la fuente de verdad durable)
    → Buffer write se descarta, se loguea en AuditChain
14. Supervisor → HEALTHY
```

---

## Fuentes y referencias

### Model Selection & Bandits
- [Thompson Sampling vs UCB in Dynamic Environments (2025)](https://www.itm-conferences.org/articles/itmconf/abs/2025/09/itmconf_cseit2025_01029/itmconf_cseit2025_01029.html)
- [Multi-Armed Bandit Problem — Lil'Log](https://lilianweng.github.io/posts/2018-01-23-multi-armed-bandit/)
- [RL-Enhanced Learned Index Tuning — ACM 2025](https://dl.acm.org/doi/10.1145/3725257)

### Compression & Storage
- [TDengine: Delta Encoding for Time Series](https://docs.tdengine.com/inside-tdengine/data-compression/)
- [ClickHouse Compression Codecs](https://clickhouse.com/resources/engineering/database-compression)
- [Meta OpenZL: Structured Data Compression (2025)](https://www.infoq.com/news/2025/10/openzl-structured-compression/)

### Prompt Compression
- [LLMLingua-2: Task-Agnostic Prompt Compression — Microsoft](https://llmlingua.com/llmlingua2.html)
- [Prompt Compression Survey — NAACL 2025](https://aclanthology.org/2025.naacl-long.368.pdf)

### Anomaly Detection
- [LTFAD: Lightweight All-MLP Anomaly Detection (2025)](https://www.sciencedirect.com/science/article/abs/pii/S0893608025002795)
- [Deep Learning for Time Series Anomaly Detection — ACM Survey](https://dl.acm.org/doi/10.1145/3691338)

### Audit & Immutability
- [Building Tamper-Proof Audit Trails (2025)](https://dev.to/veritaschain/building-tamper-proof-audit-trails-what-three-2025-trading-disasters-teach-us-about-cryptographic-378g)
- [Merkle Trees for Event Logging](https://medium.com/@vanabharathiraja/%EF%B8%8F-building-a-tamper-proof-event-logging-system-e71dfbc3c58a)
- [Event Sourcing Pattern — Azure Architecture](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)

### Resiliencia
- [Resilience Patterns: Circuit Breaker, Bulkhead, Retry — Design Gurus](https://www.designgurus.io/answers/detail/what-are-design-patterns-for-resilient-microservices-circuit-breaker-bulkhead-retries)
- [Resilient Microservices: Systematic Review (2025)](https://arxiv.org/html/2512.16959v1)

### WAL & Crash Recovery
- [Write-Ahead Log Foundation — Architecture Weekly](https://www.architecture-weekly.com/p/the-write-ahead-log-a-foundation)
- [ARIES Crash Recovery Algorithm](https://sookocheff.com/post/databases/write-ahead-logging/)
- [PostgreSQL WAL Documentation](https://www.postgresql.org/docs/current/wal-intro.html)

### CRDTs & Distributed State
- [CRDT Dictionary: Field Guide (2025)](https://www.iankduncan.com/engineering/2025-11-27-crdt-dictionary/)
- [Delta State CRDTs — CRDT.tech](https://crdt.tech/)

### Self-Tuning Systems
- [Self-Tuning Database Systems — ACM Survey](https://dl.acm.org/doi/10.1145/3665323)
- [SALI: Scalable Adaptive Learned Index — ACM](https://dl.acm.org/doi/10.1145/3626752)

---

*Documento creado: 15 marzo 2026. Version: rev-2 (post-auditoria). Siguiente paso: implementar Prioridad Absoluta.*
