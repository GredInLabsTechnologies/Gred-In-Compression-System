# AGENT PROTOCOL V1.3

Este protocolo es de obligado cumplimiento para cualquier agente (AI) cuando el usuario invoque el comando `/v1.3`.

## 1. Activación
Al recibir `/v1.3`, el agente DEBE:
1. Leer el contexto en el orden exacto especificado.
2. Declarar su cometido inicial.
3. Limitar su trabajo estrictamente a la fase asignada.

## 2. Lectura Obligatoria de Contexto (Orden Exacto)
1. `docs/PRODUCTION_PLAN_V1_3.md`
2. `docs/REPO_LAYOUT.md`
3. `docs/FORMAT.md`
4. `docs/SECURITY_MODEL.md`
5. `docs/reports/GICS_v1.3_IMPLEMENTATION_REPORT.md`

## 3. Declaración Inicial (Plantilla)
El primer mensaje del agente tras `/v1.3` debe incluir:
- **COMETIDO**:
  - **Fase**: [Número de Fase]
  - **Objetivos**: [Lista de objetivos]
  - **Checklist**: [Copia del checklist de la fase del Production Plan]
  - **Archivos a tocar**: [Lista de rutas absolutas]
  - **Gates**: [Lista de tareas de VS Code a ejecutar]

## 4. Ciclo de Implementación
1. **Implementar**: Realizar cambios de código.
2. **Ejecutar Gates**: Correr `gics: gates` (build + test) y opcionalmente bench/verify.
3. **Reparar**: Si los gates fallan, iterar hasta que estén en verde ("verde" = éxito).
4. **Permiso de Revisión**: Una vez completado y en verde, pedir explícitamente:  
   > "Permiso para revisar la fase [N]..."

## 5. Cierre de Fase
1. **Actualizar Production Plan**: Marcar las tareas como completadas en `docs/PRODUCTION_PLAN_V1_3.md`.
2. **Permiso de Commit**: Pedir explícitamente:  
   > "Permiso para hacer commit y push."
3. **Commit/Push**: Solo tras recibir el "OK".
4. **Finalizar**: Declarar "Finalizado." y apagarse.

## 6. Restricciones Críticas
- **Prohibido** trabajar fuera de la fase asignada.
- **Prohibido** `git commit` o `git push` sin permiso explícito.
- **Prohibido** avanzar a la siguiente fase sin consentimiento.
- **Obligatorio** ejecutar los gates y reportar resultados factuales.
