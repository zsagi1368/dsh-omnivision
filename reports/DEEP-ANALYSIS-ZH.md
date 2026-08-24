# DSH Omnivision — Análisis Profundo del Código

> **Fecha**: 2026-08-21  
> **Versión**: 0.1.0-alpha  
> **Estado**: ✅ Núcleo funcional, requiere correcciones para producción

---

## Resumen Ejecutivo

El plugin **dsh-omnivision** implementa una arquitectura innovadora de "Vision Pre-Step Bridge" que procesa imágenes ANTES de que DeepSeek las vea, convirtiendo todo a texto puro. Esto garantiza que el KV Cache nunca se contamina.

**Estado actual**: 56/56 tests pasan ✅ | TypeScript limpio ✅ | Build exitoso ✅

---

## Arquitectura Central

```
Usuario pega imagen
    ↓
[Pre-Step Bridge intercepta]
    ├─ VisionBridge: Imagen → Descripción textual
    ├─ MessageRewriter: Reescritura a texto puro
    └─ ShadowHistory: UI muestra imagen / Modelo ve texto
    ↓
DeepSeek recibe solo texto → KV Cache 100% protegido ✅
```

---

## Hallazgos por Módulo

### VisionBridge (`src/bridge/vision-bridge.ts`)
- ✅ Caché con TTL 1h + LRU 100 entries
- ✅ Failover via chain.ts con CircuitBreaker persistente
- ⚠️ Key de caché incluye query (prioridad: usar solo contentHash)
- ⚠️ Sin estadísticas de hit rate

### Providers (`src/vision/providers.ts`)
- ✅ 5 providers: OpenAI, Anthropic, Gemini, OVH, Zhipu
- ✅ Todos usan `redirect: 'manual'` para SSRF
- ✅ API keys en headers (no URLs)
- ❌ `baseUrl` y `model` de config son ignorados
- ❌ `gpt-4-vision-preview` está deprecado → usar `gpt-4o`
- ⚠️ Path validation no usa el mismo Policy que el plugin

### Chain (`src/vision/chain.ts`)
- ✅ Failover con timeout doble (total + provider)
- ✅ CircuitBreaker persistente aceptado como parámetro
- ✅ 11 categorías de error con clasificación automática
- ✅ Redacción de secretos en errores

### Security (`src/security/index.ts`)
- ✅ SSRF: DNS pinning + IP privado bloqueado
- ✅ PathPolicy: comparación por segmentos (fix aplicado)
- ✅ Triple capa de redacción de credenciales
- ⚠️ TOCTOU en rejectSymlink
- ⚠️ `/tmp-evil` podría evadir PathPolicy

### Plugin Entry (`src/plugin/index.ts`)
- ✅ Shadow History con eventId real
- ✅ Procesa auto/interactive/manual modes
- ❌ `composeProviders` ignora `baseUrl`/`model` del config
- ❌ `bytes: 0` cuando attachments no tienen metadata
- ⚠️ `visionDepth`/`downscale` config no se usa

### Tools (`src/tools/types.ts`)
- ⚠️ `TOOLS` array tiene handlers que apuntan a `./index.ts` (vacío)
- ❌ NUNCA usado por `callTool()` — código muerto

### Utils (`src/utils/image.ts`)
- ✅ Magic byte detection implementado
- ✅ MIME detection + size validation
- ❌ NUNCA llamado desde el plugin — código muerto

---

## Issues Clasificados

### 🔴 P0 — Bloqueantes para Producción

| # | Problema | Fix |
|---|---------|-----|
| 1 | TOOLS array → handlers broken | Eliminar TOOLS o implementar |
| 2 | image.ts utilidades nunca usadas | Integrar o eliminar |
| 3 | Custom provider baseUrl/model ignorado | Soportar en composeProviders |
| 4 | maxImageBytes config no enforceado | Agregar check en plugin |
| 5 | visionDepth/downscale ignorados | Pasar a bridge/providers |

### 🟡 P1 — Importantes

| # | Problema | Fix |
|---|---------|-----|
| 6 | PathPolicy: `/tmp-evil` evade | Usar path.normalize + segment compare |
| 7 | ShadowHistory: 1 replacement para N imágenes | Uno por imagen |
| 8 | callTool: sin param validation | Schema validation |
| 9 | bytes: 0 sin metadata | Read file size |
| 10 | Cache key con query content | Hash only intent signal |

### 🟢 P2 — Mejoras

| # | Sugerencia |
|---|-----------|
| 11 | Tests unitarios para cada provider |
| 12 | Test para interactive mode |
| 13 | Test directo de chain.ts failover |
| 14 | README sync con features reales |
| 15 | Health check periódico |

---

## Matriz de Tests

| Módulo | Archivos | Casos | Estado |
|--------|---------|-------|--------|
| Bridge | 2 | 14 | ✅ |
| Security | 2 | 18 | ✅ |
| Utils | 1 | 6 | ✅ |
| Resilience | 1 | 6 | ✅ |
| Integration | 1 | 12 | ✅ |
| **Total** | **7** | **56** | **✅ 100%** |

**Faltan**: Provider tests, Chain direct tests, Interactive mode tests

---

## Comparación con Referencias

| Característica | omnivision | modlens | toolkit | router |
|---------------|-----------|---------|---------|--------|
| KV Cache safe | ✅ | ✅ | ⚠️ | ❌ |
| Tools count | 0* | 1 | 10 | 14 |
| Free fallback | ✅ | ✅ | ✅ | ✅ |
| Local Ollama | ❌ | ❌ | ❌ | ✅ |
| Bootstrap/1+x | ❌ | ❌ | ❌ | ✅ |
| Pixel tools | ❌ | ❌ | ✅ | ❌ |
| Concurrent ctrl | ❌ | ❌ | ✅ | ✅ |

*Los tools existen en types.ts pero callTool usa executeWithFailover directo

---

## Puntuación Final

| Dimensión | Score | Nota |
|-----------|-------|------|
| Core Architecture | 8.5/10 | Diseño sólido, KV protection guaranteed |
| Code Quality | 7/10 | Type-safe but dead code exists |
| Security | 7.5/10 | Good layers, some gaps |
| Test Coverage | 7/10 | Core paths covered, edge cases missing |
| Doc Credibility | 6/10 | README overstates capabilities |
| Build Readiness | 8/10 | Builds clean, missing CLI |

### **Overall: 7.2/10**

**Verdict**: Alpha prototype is solid. Core architecture is correct and secure. Needs P0 fixes before production release. Main gaps: incomplete tool set, config flexibility, and test coverage for providers/chain.

---

*Reporte generado por Hermes Agent*
*Basado en 4 rondas de code review + 3 rondas de security review*
